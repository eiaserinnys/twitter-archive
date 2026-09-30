# twitter-archive

X(트위터) 계정 하나의 트윗을 연도와 주제로 둘러보고, 기억나는 내용으로 찾아보는 자가 호스팅 아카이브입니다. 과거 트윗은 X 데이터 아카이브(zip)로 가져오고, 이후 새 트윗은 30분마다 X API로 모읍니다. 주제 분류와 검색에는 TypeSafe의 [Jev](https://typesafe.ai/blog/introducing-system-one-models-and-jev)를 씁니다.

A self-hosted archive for one X account. Browse posts by year and topic, search them by meaning with Jev, and choose what visitors can see. Runs on Cloudflare Workers, D1 and R2, or on your own server with Node.js and SQLite.

**시연**: [서소영 트윗 아카이브](https://seosoyoung.eiaserinnys.me/twitter/). AI 에이전트 서소영(@seosoyoung_ai)의 트윗으로 만든 방문자 화면입니다. 미리 정해 둔 문구로 검색해 볼 수 있습니다.

![연도와 주제별 트윗 수를 보여 주는 연표](docs/screenshots/timeline.png)

<details>
<summary>화면 더 보기</summary>

![한 해를 월별로 펼치고 주제를 고른 화면](docs/screenshots/month.png)

![소유자가 기억나는 내용으로 검색한 결과](docs/screenshots/search.png)

![주제별 공개 숨김 기준을 고르는 설정 화면](docs/screenshots/settings.png)

</details>

## 주요 기능

- **연표**: 연도별로 어떤 주제를 얼마나 이야기했는지 칸마다 트윗 수로 보여 줍니다. 연도를 누르면 월별로 펼쳐집니다.
- **주제별 보기**: 칸을 누르면 그 시기, 그 주제의 트윗을 모아 봅니다.
- **뜻 검색**: 정확한 단어가 아니라 기억나는 내용으로 찾습니다.
- **오늘**: 몇 년 전 같은 날의 트윗과 날짜별 달력입니다.
- **아티클과 링크 카드**: X 아티클은 제목과 본문을 펼쳐 읽고, 트윗 속 링크에는 미리보기 카드를 붙입니다.
- **기간 태그**: 경력이나 그때 즐긴 게임, 영화, 책에 기간을 붙여 연표와 함께 봅니다.
- **공개 범위**: 주제별 기준과 트윗별 설정으로 방문자에게 보일 트윗을 고릅니다.
- **자동 수집**: 새 트윗과 사진, 영상, 아티클 본문을 30분마다 가져와 채점합니다.

## 시작하기 전에

한 사람이 자기 계정 하나를 보관하는 도구입니다. 설치 방법은 두 가지이고, 같은 설치 명령과 설정 파일을 씁니다.

| | Cloudflare | 내 서버 |
| :-- | :-- | :-- |
| 실행 | Workers | Node.js 또는 Docker |
| 저장 | D1, R2 | SQLite 파일과 폴더 |
| 소유자 로그인 | Cloudflare Access 또는 비밀번호 | 비밀번호 |
| 서버 관리 | 없음 | HTTPS와 백업을 직접 |

공통 준비물:

- Git, Node.js 22 이상, npm
- X 데이터 아카이브 zip: X의 "설정 및 개인정보 > 내 계정 > 데이터 아카이브 다운로드"에서 받습니다. 없어도 설치할 수 있지만 그때는 X API가 돌려주는 최근 트윗 3,200개까지만 들어옵니다.
- Jev API 키: 주제 분류와 검색이 Jev로 동작하므로 필요합니다. [TypeSafe](https://typesafe.ai)에서 발급합니다.
- X API 토큰(선택): 새 트윗 자동 수집, 답글의 원글 채우기, 아티클 본문에 필요합니다. X 개발자 앱의 앱 전용 토큰(Bearer)을 씁니다.

트윗과 미디어는 내 Cloudflare 계정이나 내 서버에 저장합니다. 다만 주제 분류와 검색을 할 때 트윗 글이 Jev API로 전달됩니다.

## Cloudflare에 설치

### 1. 소스와 API 토큰

```bash
git clone https://github.com/eiaserinnys/twitter-archive.git
cd twitter-archive
npm ci
```

Cloudflare 대시보드의 "내 프로필 > API 토큰"에서 토큰을 만듭니다. 필요한 권한은 Workers 스크립트, D1, R2, Workers 경로 편집과 영역(Zone) 읽기입니다. Access로 소유자 로그인을 만들려면 Access 앱과 정책 편집도 더합니다. 권한이 모자라면 설치가 해당 호출에서 멈추고 실패한 요청을 알려 줍니다.

### 2. 설정 파일

인스턴스 이름을 하나 정하고 예시 파일을 복사합니다. `instances/`는 커밋되지 않습니다.

```bash
mkdir -p instances/my-archive
cp instance.example.json instances/my-archive/config.json
```

| 항목 | 뜻 |
| :-- | :-- |
| `worker_name` | Worker 이름. D1과 R2 이름의 기본값도 됩니다 |
| `domain` | 비우면 `workers.dev` 주소. `hostname`만 쓰면 그 주소 전체를 씁니다. `path`(예: `/twitter`)를 함께 쓰면 기존 사이트의 하위 경로에 붙습니다 |
| `vars` | 화면 제목, 계정명, 소유자 이메일 같은 설정. 아래 [설정](#설정) 표 참고 |
| `archive` | X 데이터 아카이브 zip 경로 |
| `fetch_context_max_usd` | 답글의 원글과 인용한 글을 X API로 채울 때 쓸 최대 금액. 0이면 건너뜁니다 |
| `score_max_usd` | 설치 중 과거 트윗 채점에 쓸 최대 Jev 금액. 기본 2달러. 아카이브의 과거 트윗은 설치 중에만 채점되므로 0으로 두면 연표에 주제가 잡히지 않습니다 |
| `access` | 있으면 소유자 로그인용 Access 앱을 만듭니다. `policy_ids`에 붙일 재사용 정책 ID를 적습니다 |

하위 경로에 붙일 때는 그 호스트의 DNS 레코드가 Cloudflare 프록시(주황 구름)를 거치게 되어 있어야 합니다.

### 3. 설치 실행

비밀값은 설정 파일이 아니라 환경변수로 넘깁니다. 먼저 `--dry-run`으로 무엇을 만들지 확인합니다.

```bash
export CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=...
export TYPESAFE_BASE_URL=... TYPESAFE_API_KEY=...
export X_BEARER_TOKEN=...          # 선택

npm run setup -- --instance my-archive --dry-run
npm run setup -- --instance my-archive
```

설치는 이 순서로 진행합니다.

1. D1 데이터베이스와 R2 버킷을 찾고, 없으면 만듭니다.
2. `wrangler.toml`을 바탕으로 이 인스턴스의 `wrangler.my-archive.toml`을 만듭니다.
3. D1 스키마를 적용합니다.
4. 아카이브가 있으면 트윗을 읽고, 원글을 채우고, 채점한 뒤 D1과 R2에 올립니다. 없으면 기본 주제만 넣습니다.
5. Access 앱을 만들고(설정한 경우) Worker를 배포한 뒤 비밀값을 등록합니다.
6. 사이트 주소의 상태 확인과 트윗 수를 출력합니다.

중간에 멈추거나 채점 금액 상한에 닿으면 같은 명령을 다시 실행합니다. 끝난 작업은 건너뛰고, 소유자가 화면에서 바꾼 트윗 공개 설정과 주제 설정은 덮어쓰지 않습니다.

### 4. 확인

출력된 주소를 열면 방문자 화면이 보입니다. 우상단 로그인으로 들어가면 소유자 화면입니다. 아카이브 없이 설치했다면 첫 수집이 30분 안에 최근 트윗을 가져옵니다. 새로 만든 Worker는 예약 작업이 걸리기까지 15분쯤 더 걸릴 수 있습니다.

## 내 서버에 설치

설정 파일에 `"target": "node"`를 넣으면 Cloudflare 대신 SQLite 파일과 폴더에 저장합니다. 소유자 로그인은 비밀번호로 합니다.

```json
{
  "worker_name": "my-archive",
  "target": "node",
  "vars": {
    "SITE_TITLE": "나의 트윗 아카이브",
    "ACCOUNT_HANDLE": "your_handle",
    "OWNER_AUTH": "password"
  },
  "archive": "path/to/your-archive.zip"
}
```

```bash
export OWNER_PASSWORD='12자 이상의 비밀번호'
export TYPESAFE_BASE_URL=... TYPESAFE_API_KEY=...
export X_BEARER_TOKEN=...          # 선택

npm run setup -- --instance my-archive
INSTANCE=my-archive docker compose up -d --build
```

Docker 없이 실행하려면 `npm run serve -- --instance my-archive`를 씁니다. 두 방법 모두 `127.0.0.1:8787`에서만 열립니다. 밖에서 접속하려면 Caddy나 nginx 같은 리버스 프록시로 HTTPS를 붙입니다. 하위 경로로 붙일 때는 설정 파일의 `domain.path`에 그 경로를 적습니다.

데이터는 `instances/my-archive/runtime/`(SQLite 파일과 미디어 폴더)에 있습니다. 이 폴더를 백업하면 됩니다. 비밀값은 설치가 만든 `instances/my-archive/.env`(권한 600)에 들어갑니다.

## 방문자와 소유자

| 기능 | 방문자 | 소유자 |
| :-- | :-- | :-- |
| 연표와 트윗 목록 | 공개된 트윗만 | 숨긴 트윗까지 |
| 검색 | 소유자가 정한 문구를 골라 검색 | 문장을 직접 입력 |
| 트윗 공개 설정 | 볼 수 없음 | 트윗마다 자동, 공개에서 숨김, 항상 공개 |
| 주제, 기간 태그, 공개 검색 문구 | 볼 수 없음 | 화면에서 편집 |

방문자 검색은 Jev 호출 비용이 들기 때문에 소유자가 정한 문구만 쓰게 했습니다. 문구마다 첫 검색 결과를 새 트윗이 들어올 때까지 저장해 둡니다. `VISITOR_SEARCH`를 `off`로 두면 방문자 검색을 아예 닫습니다.

기본 주제 중 **민감**은 정치적이거나 사회적으로 논쟁을 부를 수 있는 주장을 판정합니다. 기본 설정에서는 이 주제 점수가 0.5 이상인 트윗을 방문자에게 숨기고, 연표에는 민감 칸을 표시하지 않습니다. 기준은 설정 화면의 슬라이더로 바꾸고, 판정이 틀린 트윗은 트윗마다 직접 고칩니다. 자동 판정은 틀릴 수 있으니 공개하기 전에 소유자 화면에서 한 번 훑어보기를 권합니다.

## 설정

설정 파일의 `vars`에 적습니다. 설치가 채우는 값은 따로 적지 않아도 됩니다.

| 변수 | 뜻 | 기본값 |
| :-- | :-- | :-- |
| `SITE_TITLE` | 화면 제목 | `Tweet Archive` |
| `ACCOUNT_HANDLE` | 계정명(`@` 제외) | 없음 |
| `X_USER_ID` | 계정의 숫자 ID. 비우면 설치가 아카이브나 X API에서 찾습니다 | 설치가 채움 |
| `OWNER_AUTH` | 소유자 로그인 방식. `access` 또는 `password` | `access` |
| `OWNER_EMAILS` | Access로 들어올 소유자 이메일(쉼표로 구분) | 없음 |
| `OWNER_SERVICE_TOKEN_IDS` | 소유자로 인정할 Access 서비스 토큰의 클라이언트 ID. 스크립트로 소유자 API를 쓸 때 | 없음 |
| `ACCESS_TEAM_DOMAIN` | Zero Trust 팀 도메인. 비우면 설치가 조회합니다 | 설치가 채움 |
| `ACCESS_AUD` | Access 앱 식별값 | 설치가 채움 |
| `BASE_PATH` | 하위 경로 | `domain.path`에서 채움 |
| `VISITOR_SEARCH` | 방문자 검색. `presets` 또는 `off` | `presets` |
| `SEARCH_DAILY_LIMIT` | 방문자 검색의 하루 Jev 호출 한도 | `200` |
| `JEV_MONTHLY_USD_CAP` | 자동 채점의 월 Jev 비용 상한(달러) | `5` |
| `ROBOTS_NOINDEX` | `1`이면 검색엔진 색인을 막습니다 | 빈 값 |
| `SOURCE_URL` | 화면 아래 소스 링크. 비우면 표시하지 않습니다 | 이 리포 |

### Umami 분석

인스턴스 `config.json`의 `analytics`에 `umami_script_url`과 `umami_website_id`를 설정하면 됩니다. 두 값이 모두 비어 있지 않을 때만 HTML 페이지에 Umami 스크립트를 넣습니다.

자기 방문을 통계에서 제외하려면 해당 브라우저에서 `localStorage.setItem("umami.disabled", "1")`을 실행하세요.

비밀값은 환경변수로만 넘깁니다. Cloudflare에서는 Worker 비밀값으로, 내 서버에서는 `.env` 파일로 들어갑니다.

| 비밀값 | 뜻 |
| :-- | :-- |
| `TYPESAFE_BASE_URL`, `TYPESAFE_API_KEY` | Jev 호출 |
| `X_BEARER_TOKEN` | X API 앱 전용 토큰 |
| `OWNER_PASSWORD` | 비밀번호 로그인(12자 이상). 바꾸면 기존 로그인이 모두 풀립니다 |

기본 주제 14개는 [`src/shared/topics.json`](src/shared/topics.json)에 있고, 처음 설치할 때 들어갑니다. 이후에는 설정 화면에서 추가하고 고칩니다. 주제 문구를 바꾸면 그 주제만 다시 채점합니다. 처음부터 다른 주제로 시작하려면 같은 형식의 파일을 만들어 설정 파일의 `topics`에 경로를 적습니다.

설정 화면의 「기타」를 켜면 다른 활성 주제에 들지 않고 공개 숨김도 아닌 트윗을 연표 맨 오른쪽과 달력에서 볼 수 있습니다. 기본값은 꺼짐입니다.

## 자동 수집과 채점

30분마다 X API에서 새 트윗을 가져오고 사진과 영상을 저장한 뒤 채점합니다. 한 번에 최대 3,200개까지 가져옵니다. 아카이브로 설치했다면 아카이브의 마지막 트윗 다음부터 시작합니다. 아티클을 올린 트윗은 제목과 본문을 함께 저장하고, 링크만 남아 있던 예전 아티클도 같은 때 채웁니다.

채점은 트윗마다 Jev에 "이 트윗은 이 주제에 관한 이야기인가?"를 물어 0에서 1 사이 점수를 받는 방식입니다. 연표에는 0.7 이상만 세고, 검색 후보는 놓치지 않도록 0.5 이상에서 고릅니다. 자동 채점 비용이 `JEV_MONTHLY_USD_CAP`에 닿으면 그달의 자동 채점을 멈춥니다.

## 비용

| 항목 | 드는 때 | 단가 |
| :-- | :-- | :-- |
| X API 게시물 읽기 | 새 트윗 수집, 답글의 원글 채우기(선택), 아티클 본문 | 건당 $0.005 |
| X API 사용자 조회 | `X_USER_ID`를 비우고 아카이브 없이 설치할 때 한 번 | $0.01 |
| Jev | 채점과 검색 | 입력 100만 토큰당 $0.042 |
| Cloudflare Workers, D1, R2 | Cloudflare 설치 | 무료 한도 안에서는 0 |

트윗 2만 개 계정에서 잰 값입니다(2026년 9월 단가, 기본 주제 14개).

- 설치 때 답글의 원글 채우기: $20~35. 답글이 많을수록 늘고, 건너뛸 수 있습니다.
- 설치 때 전체 채점: 약 $1
- 새 트윗 수집: 한 달 $0.5 안팎

트윗과 사진이 많으면 Cloudflare 무료 한도가 빠듯할 수 있습니다. 한도와 요금은 [Workers](https://developers.cloudflare.com/workers/platform/pricing/), [D1](https://developers.cloudflare.com/d1/platform/pricing/), [R2](https://developers.cloudflare.com/r2/pricing/) 문서에서 확인하세요. X API 단가는 [X 가격 안내](https://docs.x.com/x-api/getting-started/pricing)를 따릅니다.

## 자주 묻는 질문

**X API 없이 쓸 수 있나요?**
아카이브 zip만으로 과거 트윗과 미디어는 모두 들어옵니다. 새 트윗 자동 수집, 답글의 원글, 아티클 본문만 빠집니다.

**무엇이 들어가나요?**
내 트윗, 답글, 인용, 사진, 영상, GIF, 아티클입니다. 리트윗과 DM은 넣지 않습니다.

**설치가 중간에 멈췄어요.**
같은 명령을 다시 실행하세요. 이미 끝난 단계는 건너뜁니다.

**새 트윗이 연표에 안 보여요.**
수집은 30분마다, 채점은 그 직후에 합니다. 연표는 주제 점수 0.7 이상만 세므로 주제가 뚜렷하지 않은 트윗은 칸에 잡히지 않고 최근 트윗 목록에만 보입니다.

**오래된 빈 구간을 채우고 싶어요.**
X 데이터 아카이브를 새로 받아 설정 파일의 `archive`를 바꾸고 설치를 다시 실행하세요. 이미 있는 트윗은 그대로 두고 빠진 트윗만 더합니다.

**백업과 복원은 어떻게 하나요?**
Cloudflare 설치는 `npx wrangler d1 export DB --remote --output backup.sql --config wrangler.<이름>.toml`로 DB를 내보내고 R2 버킷을 복사해 둡니다. 복원할 때는 빈 D1에 `npx wrangler d1 execute DB --remote --file backup.sql --config wrangler.<이름>.toml`로 되돌리고 R2 파일을 다시 올립니다. 내 서버 설치는 `instances/<이름>/runtime/` 폴더를 통째로 복사하고, 복원할 때 그 폴더를 되돌린 뒤 다시 실행합니다. 원본 아카이브 zip도 함께 보관해 두면 언제든 설치를 다시 돌려 트윗과 미디어를 되살릴 수 있습니다.

## 데이터 유지보수

트윗이나 답글·인용 문맥에 `t.co` 링크가 남아 있으면, 후보 행을 내보내 링크를 다시 펼친 SQL을 만들 수 있습니다. 먼저 `X_BEARER_TOKEN`을 설정하고 아래 조회 결과를 `candidates.json`으로 저장한 뒤 스크립트를 실행하세요. 스크립트는 바뀐 텍스트만 SQL에 기록하며 채점하지 않습니다.

```sql
SELECT id, text, parent_id, parent_text, quoted_id, quoted_text
FROM tweets
WHERE text LIKE '%t.co/%'
   OR parent_text LIKE '%t.co/%'
   OR quoted_text LIKE '%t.co/%';
```

```bash
npx wrangler d1 execute DB --remote --json --command "SELECT id, text, parent_id, parent_text, quoted_id, quoted_text FROM tweets WHERE text LIKE '%t.co/%' OR parent_text LIKE '%t.co/%' OR quoted_text LIKE '%t.co/%';" --config wrangler.INSTANCE.toml > candidates.json
npm run repair-links -- --input candidates.json --output repair-links.sql --max-usd 1
npx wrangler d1 execute DB --remote --file repair-links.sql --config wrangler.INSTANCE.toml
```

`DB`와 `INSTANCE`를 운영 설정에 맞는 이름으로 바꾸세요. `--max-usd`에 조회 비용 상한을 지정합니다. 삭제되었거나 조회할 수 없는 트윗은 건너뜁니다.

## 개발

```bash
npm ci
npm test            # 합성 아카이브로 돌리는 테스트
npx tsc --noEmit    # 타입 검사
```

테스트는 만든 가짜 데이터만 씁니다. 실제 트윗, 미디어, 비밀값은 리포에 넣지 않습니다. 버그와 제안은 Issue로, 작은 수정은 PR로 보내 주세요.

## 라이선스

[MIT](LICENSE)
