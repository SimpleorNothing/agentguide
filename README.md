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
| `GET·POST /api/extra`, `DELETE /api/extra/<id>`, `GET /extra/<id>` | 클로드 에이전트 추가 가이드 — 전용 R2(`samsungda-agentguide-extra`) 목록·업로드·삭제·열람 |

> `/api/research`·`/api/extra`는 같은 핸들러(`handleBucketApi`/`serveBucketFile`)를 버킷만 바꿔 공유한다. 업로드는 삭제 비밀번호(PBKDF2 해시)를 필수로 받는다.

### R2 버킷

| 바인딩 | 버킷 | 용도 |
| --- | --- | --- |
| `RESEARCH` | `samsungda-research` | 워드보고서 작성 예시(포털과 공유) |
| `EXTRA` | `samsungda-agentguide-extra` | 클로드 에이전트 추가 가이드(전용) |

추가 가이드 버킷은 최초 1회 생성이 필요하다(없으면 업로드가 503 반환):

```bash
npx wrangler r2 bucket create samsungda-agentguide-extra
```

## 자료 출처

자료는 GitHub Releases에서 가져온다. 기본 출처는 `SimpleorNothing/report-site`이며,
`wrangler.jsonc`의 `vars`에서 바꿀 수 있다.

```jsonc
"vars": { "GITHUB_OWNER": "SimpleorNothing", "GITHUB_REPO": "report-site" }
```

저장소가 비공개이므로 목록·다운로드에는 토큰이 필요하다. 토큰은 비밀값이라
커밋하지 않고 secret으로 등록한다(`repo` 읽기 권한):

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
