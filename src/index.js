// agentguide — 클로드로 워드보고서 작성하기(가이드 자료실) Cloudflare Worker
//
// 역할:
//  0. 사이트 접근 비밀번호 게이트(포털 samsungda-portal과 세션 공유)를 모든 경로
//     앞단에 적용한다. agentguide.samsungda.net 으로 직접 들어와도 비밀번호를 받고,
//     포털(samsungda.net)에서 이미 로그인했다면 Domain=.samsungda.net 공유 쿠키로
//     재입력 없이 통과한다. SITE_PASSWORD secret이 없으면 게이트는 비활성(공개)된다.
//  1. 정적 가이드 페이지(public/index.html)를 서비스한다.
//  2. GitHub Releases를 프록시한다.
//     - GET /api/releases           → 릴리즈/자산 목록(JSON)
//     - GET /api/download/<assetId> → 비공개 저장소의 릴리즈 자산을 토큰으로 받아 전달
//  3. 조사 결과물(보고서 작성 예시)을 포털과 "같은" R2 버킷(samsungda-research)에서
//     직접 읽고 쓴다(목록/업로드/삭제/열람).
//     - GET    /api/research        → 목록
//     - POST   /api/research        → 업로드(삭제 비밀번호 필수)
//     - DELETE /api/research/<id>   → 삭제(업로드 시 설정한 비밀번호 필요)
//     - GET    /research/<id>       → 파일 열람/다운로드
//
// 메뉴3를 굳이 R2로 직접 구현하는 이유:
//   포털(samsungda.net)에는 사이트 비밀번호 게이트(SITE_PASSWORD)가 있어, 세션
//   쿠키 없는 서버-측 프록시 요청은 /api/research 까지 전부 로그인 페이지(401)로
//   막힌다. 그래서 프록시 대신 포털과 동일한 R2 버킷을 직접 바인딩해 같은 파일
//   목록을 공유한다(한쪽에 올리면 양쪽에 동일하게 보인다). 키 생성·메타데이터
//   인코딩·비밀번호 해시(PBKDF2) 방식을 포털과 똑같이 맞춰 상호 호환된다.
//
// 자료 출처(릴리스)는 기본값이 SimpleorNothing/report-site 이며, vars로 바꿀 수
// 있다. 비공개 저장소이므로 GITHUB_TOKEN(secret)이 있어야 목록·다운로드가 동작한다.
//   wrangler secret put GITHUB_TOKEN

const GH_API = "https://api.github.com";
const TEXT = { "content-type": "text/plain; charset=utf-8" };

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

// ── 비밀번호 해시(포털과 동일) ────────────────────────────────────────────────
function bytesToHex(bytes) {
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join("");
}
function hexToBytes(hex) {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}
async function pbkdf2(password, salt) {
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", salt, iterations: 100000, hash: "SHA-256" }, km, 256);
  return new Uint8Array(bits);
}
async function hashPassword(password) {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  return { pwhash: bytesToHex(await pbkdf2(password, salt)), pwsalt: bytesToHex(salt) };
}
function timingSafeEqual(a, b) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}
async function verifyPassword(password, pwhash, pwsalt) {
  if (!password || !pwhash || !pwsalt) return false;
  return timingSafeEqual(bytesToHex(await pbkdf2(password, hexToBytes(pwsalt))), pwhash);
}

// ── 사이트 접근 비밀번호 게이트 (포털 samsungda-portal과 세션 공유) ───────────
// 포털(samsungda.net)과 "같은" SITE_PASSWORD·세션 토큰·쿠키 이름을 쓰고, 쿠키를
// Domain=.samsungda.net 으로 발급해 두 출처(samsungda.net · agentguide.samsungda.net)가
// 하나의 세션을 공유한다. 따라서 포털에서 한 번 로그인했다면 여기로 직접 와도 재입력이
// 필요 없고(공유 쿠키로 통과), 반대로 여기서 로그인해도 포털에 그대로 통한다.
// SITE_PASSWORD secret이 없으면 게이트는 자동 비활성(사이트 공개)된다.
const AUTH_COOKIE = "da_portal_session";
const AUTH_MSG = "da-portal-auth-v1";
const AUTH_MAX_AGE = 60 * 60 * 24 * 180; // 약 180일 동안 재입력 없이 유지

function parseCookies(header) {
  const out = {};
  (header || "").split(";").forEach((part) => {
    const i = part.indexOf("=");
    if (i > -1) out[part.slice(0, i).trim()] = part.slice(i + 1).trim();
  });
  return out;
}

async function hmacHex(key, message) {
  const k = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(key),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(message));
  return bytesToHex(new Uint8Array(sig));
}

// 현재 비밀번호에서 결정되는 세션 토큰(비밀번호를 바꾸면 기존 쿠키 자동 무효화).
// 포털과 동일한 (SITE_PASSWORD, AUTH_MSG) 조합이라 토큰이 서로 호환된다.
function sessionToken(env) {
  return hmacHex(env.SITE_PASSWORD, AUTH_MSG);
}

async function isAuthed(request, env) {
  const cookie = parseCookies(request.headers.get("cookie"))[AUTH_COOKIE];
  if (!cookie) return false;
  return timingSafeEqual(cookie, await sessionToken(env));
}

// samsungda.net 영역에서는 서브도메인 간 공유를 위해 Domain=.samsungda.net 으로
// 쿠키를 발급하고, 로컬(localhost)·*.workers.dev 미리보기에서는 Domain을 생략해
// (호스트 한정) 브라우저가 쿠키를 거부하지 않게 한다.
function cookieDomainAttr(hostname) {
  return hostname === "samsungda.net" || hostname.endsWith(".samsungda.net")
    ? "; Domain=.samsungda.net"
    : "";
}

// 같은 출처 경로만 허용 — //evil.com 이나 절대 URL로의 오픈 리다이렉트 차단.
function safeNextPath(next) {
  return typeof next === "string" && /^\/(?!\/)/.test(next) ? next : "/";
}

function escAttr(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[m]));
}

function loginPage(next, isError) {
  const html = `<!DOCTYPE html>
<html lang="ko">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>기획 도구 모음 — 로그인</title>
<style>
  :root{--bg:#fff;--surface:#f6f7f9;--text:#1a1d21;--muted:#5b6470;--border:#e6e9ee;--brand:#1257d6}
  *{box-sizing:border-box;margin:0;padding:0}
  body{font-family:'Pretendard',system-ui,-apple-system,'Segoe UI',Roboto,'Apple SD Gothic Neo','Noto Sans KR',sans-serif;color:var(--text);background:var(--bg);min-height:100vh;display:flex;align-items:center;justify-content:center;padding:24px}
  .login{width:100%;max-width:360px;background:var(--surface);border:1.5px solid var(--border);border-radius:16px;padding:32px 28px}
  h1{font-size:22px;font-weight:800;letter-spacing:-.5px;margin-bottom:8px}
  .sub{color:var(--muted);font-size:14px;margin-bottom:22px}
  input[type=password]{width:100%;font:inherit;font-size:15px;padding:12px 14px;border:1.5px solid var(--border);border-radius:10px;background:#fff;outline:none;transition:border-color .15s}
  input[type=password]:focus{border-color:var(--brand)}
  button{width:100%;margin-top:14px;font:inherit;font-size:15px;font-weight:700;color:#fff;background:var(--brand);border:none;border-radius:10px;padding:12px 14px;cursor:pointer;transition:opacity .15s}
  button:hover{opacity:.92}
  .err{color:#c0392b;font-size:13px;margin-bottom:14px}
</style>
</head>
<body>
  <form class="login" method="POST" action="/__auth">
    <h1>기획 도구 모음</h1>
    <p class="sub">계속하려면 비밀번호를 입력하세요.</p>
    ${isError ? '<p class="err">비밀번호가 올바르지 않습니다.</p>' : ""}
    <input type="password" name="password" placeholder="비밀번호" autocomplete="current-password" autofocus required>
    <input type="hidden" name="next" value="${escAttr(safeNextPath(next))}">
    <button type="submit">입장</button>
  </form>
</body>
</html>`;
  return new Response(html, {
    status: 401,
    headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" },
  });
}

async function handleLogin(request, env, url) {
  let form;
  try {
    form = await request.formData();
  } catch {
    return loginPage("/", true);
  }
  const password = String(form.get("password") || "");
  const next = safeNextPath(String(form.get("next") || "/"));
  if (!timingSafeEqual(password, env.SITE_PASSWORD)) {
    return loginPage(next, true);
  }
  const secure = url.protocol === "https:" ? "; Secure" : "";
  const headers = new Headers({ Location: next });
  headers.append(
    "Set-Cookie",
    `${AUTH_COOKIE}=${await sessionToken(env)}; Path=/; Max-Age=${AUTH_MAX_AGE}; HttpOnly; SameSite=Lax${cookieDomainAttr(url.hostname)}${secure}`
  );
  return new Response(null, { status: 303, headers });
}

// ── GitHub Releases(메뉴1) ───────────────────────────────────────────────────
function repoSlug(env) {
  const owner = env.GITHUB_OWNER || "SimpleorNothing";
  const repo = env.GITHUB_REPO || "report-site";
  return `${owner}/${repo}`;
}

// GitHub API는 User-Agent 헤더가 없으면 요청을 거부한다. 토큰이 있으면 함께 보낸다.
function ghHeaders(env, accept = "application/vnd.github+json") {
  const h = { Accept: accept, "User-Agent": "agentguide-worker" };
  if (env.GITHUB_TOKEN) h.Authorization = `Bearer ${env.GITHUB_TOKEN}`;
  return h;
}

async function listReleases(env) {
  const url = `${GH_API}/repos/${repoSlug(env)}/releases`;
  let releases;
  try {
    const r = await fetch(url, { headers: ghHeaders(env) });
    if (!r.ok) return json({ error: `Releases 조회 실패: HTTP ${r.status}` }, 502);
    releases = await r.json();
  } catch (e) {
    return json({ error: `Releases 조회 실패: ${e}` }, 502);
  }

  const result = (releases || []).map((rel) => {
    const assets = (rel.assets || []).map((a) => ({
      name: a.name || "",
      size: a.size || 0,
      asset_id: a.id,
      download_url: a.browser_download_url,
      // created_at = 파일이 릴리즈에 업로드된 시각(업로드 날짜). 새 파일을 올리면
      // 그 자산의 created_at 이 갱신되므로 자동으로 최신 업로드 날짜가 된다.
      created_at: a.created_at || rel.published_at || "",
      updated_at: a.updated_at || rel.published_at || "",
    }));
    // 자산 '업로드일' 중 가장 최신값을 가이드 업로드일로 쓴다(자산 없으면 게시일 폴백).
    const uploads = assets.map((a) => a.created_at).filter(Boolean);
    const latest_uploaded_at = uploads.length
      ? uploads.reduce((m, x) => (x > m ? x : m))
      : rel.published_at;
    // 갱신일도 함께 노출(하위 호환).
    const updates = assets.map((a) => a.updated_at).filter(Boolean);
    const latest_updated_at = updates.length
      ? updates.reduce((m, x) => (x > m ? x : m))
      : rel.published_at;
    return {
      name: rel.name || rel.tag_name,
      tag: rel.tag_name,
      description: rel.body || "",
      published_at: rel.published_at,
      latest_uploaded_at,
      latest_updated_at,
      html_url: rel.html_url,
      assets,
    };
  });
  // 프론트의 빈번한 새로고침 대비 짧게 캐시.
  return json(result, 200, { "cache-control": "public, max-age=60" });
}

async function downloadAsset(env, assetId) {
  if (!/^\d+$/.test(assetId)) {
    return new Response("잘못된 asset id", { status: 400, headers: TEXT });
  }
  if (!env.GITHUB_TOKEN) {
    return new Response("GITHUB_TOKEN 미설정", { status: 500, headers: TEXT });
  }
  const base = `${GH_API}/repos/${repoSlug(env)}/releases/assets/${assetId}`;

  // 원본 파일명은 자산 메타데이터에서 가져온다(다운로드 응답에 없을 수 있음).
  let filename = "download";
  try {
    const meta = await fetch(base, { headers: ghHeaders(env) });
    if (meta.ok) filename = (await meta.json()).name || filename;
  } catch {
    /* 파일명 폴백 사용 */
  }

  let r;
  try {
    r = await fetch(base, {
      headers: ghHeaders(env, "application/octet-stream"),
      redirect: "follow",
    });
  } catch (e) {
    return new Response(`다운로드 실패: ${e}`, { status: 502, headers: TEXT });
  }
  if (!r.ok) {
    return new Response(`다운로드 실패: HTTP ${r.status}`, { status: 502, headers: TEXT });
  }

  const headers = new Headers();
  headers.set("content-type", r.headers.get("content-type") || "application/octet-stream");
  headers.set("x-content-type-options", "nosniff");
  // 한글 등 비ASCII 파일명을 RFC 5987 방식으로 안전하게 내려준다.
  const encoded = encodeURIComponent(filename);
  const ascii = filename.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
  headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
  return new Response(r.body, { headers });
}

// ── R2 버킷 기반 파일 목록/업로드/삭제 (보고서 예시·추가 가이드 공용) ──────────
// bucket 인자로 어떤 R2 버킷을 쓸지 주입한다(현재 RESEARCH). 키 생성·메타
// 데이터·비밀번호 해시 방식은 포털과 동일하게 유지한다.
async function handleBucketApi(request, env, bucket, id) {
  if (!bucket) return json({ error: "R2 bucket not configured" }, 503);

  // Collection: /api/research
  if (!id) {
    if (request.method === "GET") {
      const listed = await bucket.list({ include: ["customMetadata", "httpMetadata"] });
      const items = listed.objects.map((o) => ({
        id: o.key,
        title: o.customMetadata?.title ? decodeURIComponent(o.customMetadata.title) : o.key,
        name: o.customMetadata?.name ? decodeURIComponent(o.customMetadata.name) : o.key,
        size: o.size,
        type: o.httpMetadata?.contentType || "",
        uploaded: o.uploaded,
        uploader: o.customMetadata?.uploader ? decodeURIComponent(o.customMetadata.uploader) : "",
      }));
      items.sort((a, b) => new Date(b.uploaded) - new Date(a.uploaded));
      return json(items);
    }
    if (request.method === "POST") {
      let form;
      try {
        form = await request.formData();
      } catch {
        return json({ error: "expected multipart/form-data" }, 400);
      }
      const file = form.get("file");
      if (!file || typeof file.arrayBuffer !== "function") return json({ error: "missing file" }, 400);
      const password = String(form.get("password") || "");
      if (!password) return json({ error: "file password required" }, 400);
      const name = String(file.name || "untitled");
      const title = String(form.get("title") || name.replace(/\.[^.]+$/, ""));
      const uploader = String(form.get("uploader") || "").slice(0, 40);
      const safe = (name.replace(/[^\w.\-]+/g, "_").slice(-80)) || "file";
      const key = Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 7) + "-" + safe;
      const { pwhash, pwsalt } = await hashPassword(password);
      await bucket.put(key, await file.arrayBuffer(), {
        httpMetadata: { contentType: file.type || "application/octet-stream" },
        customMetadata: { title: encodeURIComponent(title), name: encodeURIComponent(name), uploader: encodeURIComponent(uploader), pwhash, pwsalt },
      });
      return json({ id: key, title, name }, 201);
    }
    return json({ error: "method not allowed" }, 405);
  }

  // Item: /api/research/<id>
  if (request.method === "DELETE") {
    const obj = await bucket.head(id);
    if (!obj) return new Response(null, { status: 204 }); // already gone
    const provided = request.headers.get("x-file-password") || "";
    const meta = obj.customMetadata || {};
    let ok;
    if (meta.pwhash && meta.pwsalt) {
      // 삭제에는 업로더가 설정한 파일별 비밀번호가 필요
      ok = await verifyPassword(provided, meta.pwhash, meta.pwsalt);
    } else {
      // 레거시 항목(파일별 비밀번호 없음): 공용 업로드 토큰으로 폴백(agentguide에는
      // UPLOAD_TOKEN이 없으므로 사실상 삭제 불가 — 포털에서 처리).
      ok = !!env.UPLOAD_TOKEN && provided === env.UPLOAD_TOKEN;
    }
    if (!ok) return json({ error: "wrong password" }, 403);
    await bucket.delete(id);
    return new Response(null, { status: 204 });
  }
  return json({ error: "method not allowed" }, 405);
}

async function serveBucketFile(bucket, id) {
  if (!bucket) return new Response("R2 bucket not configured", { status: 503, headers: TEXT });
  const obj = await bucket.get(id);
  if (!obj) return new Response("Not found", { status: 404, headers: TEXT });
  const headers = new Headers();
  obj.writeHttpMetadata(headers);
  headers.set("etag", obj.httpEtag);
  if (!headers.get("content-type")) headers.set("content-type", "application/octet-stream");
  headers.set("x-content-type-options", "nosniff");
  // 다운로드 시 R2 키(랜덤 prefix가 붙은 이름) 대신 업로드 당시의 원본 파일명을 사용한다.
  const meta = obj.customMetadata || {};
  if (meta.name) {
    const original = decodeURIComponent(meta.name);
    const encoded = encodeURIComponent(original);
    const ascii = original.replace(/[^\x20-\x7E]/g, "_").replace(/["\\]/g, "_");
    headers.set("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`);
  }
  headers.set("cache-control", "private, max-age=300");
  // 업로드된 콘텐츠는 불투명 오리진(sandbox)에서 렌더링해 포털 저장소/쿠키를
  // 절대 읽지 못하게 한다.
  headers.set(
    "content-security-policy",
    "sandbox allow-scripts allow-popups allow-forms allow-modals allow-downloads"
  );
  return new Response(obj.body, { headers });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // 사이트 접근 비밀번호 게이트(포털 samsungda-portal과 세션 공유).
    // 포털에서 이미 로그인했다면 Domain=.samsungda.net 공유 쿠키로 그대로 통과하고,
    // 아니면 로그인 페이지를 띄운다. 통과 전에는 가이드 페이지·조사 결과물(R2) 등
    // 어떤 경로도 노출하지 않는다. SITE_PASSWORD 미설정 시 게이트는 비활성(공개).
    if (env.SITE_PASSWORD) {
      if (path === "/__auth" && request.method === "POST") {
        return handleLogin(request, env, url);
      }
      if (!(await isAuthed(request, env))) {
        return loginPage(path + (url.search || ""), false);
      }
    }

    // 메뉴1: GitHub Releases
    if (path === "/api/releases") {
      return listReleases(env);
    }
    if (path.startsWith("/api/download/")) {
      const id = decodeURIComponent(path.slice("/api/download/".length));
      return downloadAsset(env, id);
    }

    // 워드보고서 작성 예시: 조사 결과물(포털과 동일 R2 버킷 RESEARCH 직접 접근)
    if (path === "/api/research") {
      return handleBucketApi(request, env, env.RESEARCH, null);
    }
    if (path.startsWith("/api/research/")) {
      const rid = decodeURIComponent(path.slice("/api/research/".length));
      return handleBucketApi(request, env, env.RESEARCH, rid);
    }
    if (path.startsWith("/research/")) {
      const rid = decodeURIComponent(path.slice("/research/".length));
      if (!rid) return new Response("Not found", { status: 404, headers: TEXT });
      return serveBucketFile(env.RESEARCH, rid);
    }

    // 그 외 모든 경로는 정적 자산(가이드 페이지)으로 서비스.
    return env.ASSETS.fetch(request);
  },
};
