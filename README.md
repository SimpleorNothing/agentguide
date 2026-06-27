# agentguide

**클로드 에이전트 만들기** — 활용법·작업 가이드 자료실. Claude 에이전트를 직접 만드는 데
필요한 가이드 자료를 GitHub Releases에서 받아 다운로드할 수 있는 단일 페이지 사이트.

기존에는 `report-site`(FastAPI/Railway) 백엔드가 `samsungda.net/agent-guide` 경로로
서비스하던 것을, 다른 도구들(report·mi·2030·quickshare·space)처럼 전용 레포 +
Cloudflare Worker로 분리한 것이다.

## 구성

```
public/index.html   가이드 페이지(자료 목록·다운로드 UI)
src/index.js        Worker — 정적 자산 서비스 + GitHub Releases 프록시
wrangler.jsonc      Cloudflare Worker 설정(라우트·자산·vars)
```

### 엔드포인트

| 경로 | 설명 |
| --- | --- |
| `GET /` | 가이드 페이지(정적) |
| `GET /api/releases` | 릴리즈/자산 목록(JSON) |
| `GET /api/download/<assetId>` | 비공개 저장소의 릴리즈 자산을 토큰으로 받아 전달 |
| `GET·POST /api/research`, `DELETE /api/research/<id>`, `GET /research/<id>` | 워드보고서 작성 예시 — 포털 공유 R2(`samsungda-research`) 목록·업로드·삭제·열람 |

> 업로드는 삭제 비밀번호(PBKDF2 해시)를 필수로 받는다(`handleBucketApi`/`serveBucketFile`).

## 접근 보호 (비밀번호 게이트 — 포털과 세션 공유)

`SITE_PASSWORD`(secret)가 설정되면 **모든 경로**가 사이트 비밀번호 게이트 뒤로 들어간다.
`agentguide.samsungda.net`으로 직접 접속해도 비밀번호를 입력해야 하며, 통과 전에는
가이드 페이지·릴리즈·조사 결과물(R2) 어떤 경로도 노출되지 않는다.

포털(`samsungda-portal`)과 **세션을 공유**한다:

- 같은 쿠키 이름(`da_portal_session`)·같은 토큰 파생(`HMAC(SITE_PASSWORD, "da-portal-auth-v1")`)을 사용.
- 로그인 쿠키를 `Domain=.samsungda.net`으로 발급 → `samsungda.net`과 `agentguide.samsungda.net`이 한 세션을 공유.
- 따라서 **포털에서 클릭해 들어오면(이미 로그인 상태) 재입력이 필요 없고**, 여기서 로그인해도 포털에 그대로 통한다.
- 비밀번호를 바꾸면 파생 토큰이 달라져 기존 쿠키가 자동 무효화된다.

```bash
# 포털과 "같은 값"을 넣어야 세션이 호환된다.
wrangler secret put SITE_PASSWORD
```

> `SITE_PASSWORD`를 설정하지 않으면 게이트는 비활성화되고 사이트가 공개된다.
> 로컬(`localhost`)·`*.workers.dev` 미리보기에서는 쿠키 `Domain`을 생략하므로
> 세션 공유는 실제 `*.samsungda.net` 도메인에서만 동작한다.

## 자료 출처

자료는 GitHub Releases에서 가져온다. 출처는 `SimpleorNothing/report-site` 의
`latest-guides` 릴리즈이며, `wrangler.jsonc`의 `vars`에서 바꿀 수 있다. 가이드 자산은
**report-site 로 단일화**한다(Google Drive → report-site `prompts/`·`latest-guides` 릴리즈
동시 동기화). 이 레포(agent-guide)는 표시(프록시) 레이어만 담당한다.

```jsonc
"vars": { "GITHUB_OWNER": "SimpleorNothing", "GITHUB_REPO": "report-site" }
```

report-site 가 비공개이므로 목록·다운로드에는 토큰이 필요하다. 토큰은 비밀값이라
커밋하지 않고 secret으로 등록한다(report-site `repo` 읽기 권한):

```bash
wrangler secret put GITHUB_TOKEN
```

로컬 개발 시에는 `.dev.vars`에 `GITHUB_TOKEN=...`을 두면 된다(`.gitignore` 처리됨).

## 배포

```bash
npm install
npm run deploy
```

서브도메인은 `wrangler.jsonc`의 `routes` 한 줄로 관리한다(기본 `agentguide.samsungda.net`).
zone(`samsungda.net`)이 같은 Cloudflare 계정에 있어야 하며, Custom Domain 연결은
대시보드가 아니라 이 `custom_domain` 라우트로 관리한다.

## 포털 연동

`기획 도구 모음`(samsungda-portal)의 "클로드로 워드보고서 작성하기" 카드가 이 사이트를
가리킨다. 서브도메인을 바꾸면 포털 카드의 링크도 함께 수정해야 한다.

## 개발

```bash
npm run dev   # wrangler dev (로컬)
```
