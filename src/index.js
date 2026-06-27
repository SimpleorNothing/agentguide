// agentguide — 클로드로 워드보고서 작성하기(가이드 자료실) Cloudflare Worker
//
// 역할:
//  1. 정적 가이드 페이지(public/index.html)를 서비스한다.
//  2. GitHub Releases를 프록시한다.
//     - GET /api/releases           → 릴리즈/자산 목록(JSON)
//     - GET /api/download/<assetId> → 비공개 저장소의 릴리즈 자산을 토큰으로 받아 전달
//  3. 조사 결과물(보고서 작성 예시)을 포털 워커(samsungda.net)로 프록시한다.
//     - /api/research, /api/research/<id> → 목록/업로드/삭제(R2·KV는 포털이 보유)
//     - /research/<id>                    → 업로드된 결과물 파일 다운로드
//
// 자료 출처는 기본값이 SimpleorNothing/report-site 의 GitHub Releases 이며,
// vars(GITHUB_OWNER/GITHUB_REPO)로 바꿀 수 있다. 비공개 저장소이므로
// GITHUB_TOKEN(secret)이 있어야 목록·다운로드가 동작한다.
//   wrangler secret put GITHUB_TOKEN
//
// 이 Worker는 report-site 백엔드(FastAPI)의 /agent-guide·/api/releases·
// /api/download 동작을 그대로 옮긴 것으로, 다운로드 집계/핑거프린트 같은
// report-site 내부 상태에 의존하던 부가 기능은 제외한 순수 프록시 구현이다.
// 조사 결과물(/api/research·/research)은 포털(samsungda.net) 워커가 R2·KV로
// 보유하므로, 같은 파일 저장소를 공유하도록 그쪽으로 그대로 프록시한다.

const GH_API = "https://api.github.com";
const TEXT = { "content-type": "text/plain; charset=utf-8" };

// 조사 결과물(보고서 예시)을 보유한 포털 워커. /api/research·/research/* 를
// 이 오리진으로 프록시해 포털과 동일한 파일 목록을 공유한다.
const PORTAL = "https://samsungda.net";

function json(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...extraHeaders },
  });
}

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
      updated_at: a.updated_at || rel.published_at || "",
    }));
    // 자산 갱신일 중 가장 최신값을 릴리즈 갱신일로 쓰고, 자산이 없으면 게시일로 폴백.
    const updates = assets.map((a) => a.updated_at).filter(Boolean);
    const latest_updated_at = updates.length
      ? updates.reduce((m, x) => (x > m ? x : m))
      : rel.published_at;
    return {
      name: rel.name || rel.tag_name,
      tag: rel.tag_name,
      description: rel.body || "",
      published_at: rel.published_at,
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

// 조사 결과물(보고서 예시) 관련 요청을 포털 워커로 그대로 전달한다.
// 목록(GET)·업로드(POST)·삭제(DELETE)·파일 열람(GET /research/<id>) 모두
// 포털이 R2·KV로 처리하므로, 메서드·헤더·본문을 보존해 프록시한다.
async function proxyToPortal(request, url) {
  const target = PORTAL + url.pathname + (url.search || "");
  const headers = new Headers(request.headers);
  headers.delete("host");
  const isBodyless = request.method === "GET" || request.method === "HEAD";
  try {
    return await fetch(target, {
      method: request.method,
      headers,
      redirect: "follow",
      body: isBodyless ? null : request.body,
    });
  } catch (e) {
    return new Response(`포털 프록시 실패: ${e}`, { status: 502, headers: TEXT });
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    if (path === "/api/releases") {
      return listReleases(env);
    }
    if (path.startsWith("/api/download/")) {
      const id = decodeURIComponent(path.slice("/api/download/".length));
      return downloadAsset(env, id);
    }

    // 조사 결과물(보고서 예시)은 포털(samsungda.net) 워커가 보유 — 그대로 프록시
    if (
      path === "/api/research" ||
      path.startsWith("/api/research/") ||
      path.startsWith("/research/")
    ) {
      return proxyToPortal(request, url);
    }

    // 그 외 모든 경로는 정적 자산(가이드 페이지)으로 서비스.
    return env.ASSETS.fetch(request);
  },
};
