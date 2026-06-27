#!/usr/bin/env bash
#
# report-site의 `latest-guides` 릴리즈 자산 4개를 agentguide의 동일 태그
# 릴리즈로 "이동"한다. (다운로드 → agentguide 릴리즈 생성/업로드 → 원본 삭제)
#
# 필요: GitHub 토큰(두 비공개 레포에 repo 쓰기 권한). gh CLI 또는 curl 사용.
#
#   GITHUB_TOKEN=ghp_xxx ./scripts/migrate-release-assets.sh
#
set -euo pipefail

OWNER="SimpleorNothing"
SRC_REPO="report-site"
DST_REPO="agent-guide"   # 레포가 agentguide → agent-guide 로 rename됨
TAG="latest-guides"
REL_NAME="클로드 활용법 1개, 작업가이드 3개"
API="https://api.github.com"
UPLOADS="https://uploads.github.com"

: "${GITHUB_TOKEN:?GITHUB_TOKEN 환경변수가 필요합니다 (repo 쓰기 권한)}"
AUTH=(-H "Authorization: Bearer $GITHUB_TOKEN")
JSON=(-H "Accept: application/vnd.github+json" -H "X-GitHub-Api-Version: 2022-11-28")

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

ASSETS=(
  "Claude_Report_Agent_User_Guide_v3.pptx|application/vnd.openxmlformats-officedocument.presentationml.presentation"
  "Step_1_Guide_Storyline_Structuring_v57.docx|application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  "Step_2_Guide_Document_Drafting_v57.docx|application/vnd.openxmlformats-officedocument.wordprocessingml.document"
  "Step_3_Guide_Document_Review_v57.docx|application/vnd.openxmlformats-officedocument.wordprocessingml.document"
)

echo "1) 원본 릴리즈 조회: $OWNER/$SRC_REPO@$TAG"
SRC_JSON="$(curl -fsSL "${AUTH[@]}" "${JSON[@]}" "$API/repos/$OWNER/$SRC_REPO/releases/tags/$TAG")"

echo "2) 자산 다운로드"
for entry in "${ASSETS[@]}"; do
  name="${entry%%|*}"
  aid="$(printf '%s' "$SRC_JSON" | python3 -c "import sys,json;
d=json.load(sys.stdin)
print(next(a['id'] for a in d['assets'] if a['name']=='$name'))")"
  echo "   - $name (id=$aid)"
  curl -fSL "${AUTH[@]}" -H "Accept: application/octet-stream" \
    -o "$WORK/$name" "$API/repos/$OWNER/$SRC_REPO/releases/assets/$aid"
done

echo "3) 대상 릴리즈 확보: $OWNER/$DST_REPO@$TAG"
if DST_JSON="$(curl -fsSL "${AUTH[@]}" "${JSON[@]}" "$API/repos/$OWNER/$DST_REPO/releases/tags/$TAG" 2>/dev/null)"; then
  echo "   기존 릴리즈 재사용"
else
  DST_JSON="$(curl -fsSL "${AUTH[@]}" "${JSON[@]}" -X POST \
    "$API/repos/$OWNER/$DST_REPO/releases" \
    -d "$(python3 -c "import json;print(json.dumps({'tag_name':'$TAG','name':'$REL_NAME','target_commitish':'main'}))")")"
  echo "   새 릴리즈 생성"
fi
DST_ID="$(printf '%s' "$DST_JSON" | python3 -c "import sys,json;print(json.load(sys.stdin)['id'])")"

echo "4) 자산 업로드 → $OWNER/$DST_REPO (release id=$DST_ID)"
for entry in "${ASSETS[@]}"; do
  name="${entry%%|*}"; ctype="${entry##*|}"
  echo "   - $name"
  curl -fsSL "${AUTH[@]}" -H "Content-Type: $ctype" \
    --data-binary @"$WORK/$name" \
    "$UPLOADS/repos/$OWNER/$DST_REPO/releases/$DST_ID/assets?name=$name" >/dev/null
done

echo "5) 원본 자산 삭제(이동 완료): $OWNER/$SRC_REPO"
for entry in "${ASSETS[@]}"; do
  name="${entry%%|*}"
  aid="$(printf '%s' "$SRC_JSON" | python3 -c "import sys,json;
d=json.load(sys.stdin)
print(next(a['id'] for a in d['assets'] if a['name']=='$name'))")"
  echo "   - $name (id=$aid)"
  curl -fsSL "${AUTH[@]}" "${JSON[@]}" -X DELETE \
    "$API/repos/$OWNER/$SRC_REPO/releases/assets/$aid"
done

echo "완료: 4개 자산을 $DST_REPO@$TAG 로 이동했습니다."
echo "참고: agentguide/wrangler.jsonc 의 GITHUB_REPO 를 \"$DST_REPO\" 로 바꾸면"
echo "      워커가 새 위치(agentguide 자체 릴리즈)에서 자료를 읽습니다."
