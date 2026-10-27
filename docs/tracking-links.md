# 홍보 링크 출처 표시 규칙

홍보 글에 넣는 링크는 손으로 만들지 않고 `scripts/make_link.py`로 만든다. 그래야 같은 장소가 여러 이름으로 갈라지지 않는다.

## 대상 링크

| 이름 | URL |
|---|---|
| `store` | https://chromewebstore.google.com/detail/dlifmhanolkjflblnofiifgkffhkpgga |
| `repo` | https://github.com/donasman/leeway |
| `releases` | https://github.com/donasman/leeway/releases/latest |

스토어 URL은 `scripts/make_link.py`의 `STORE_URL` 한 곳에만 있다. 바뀌면 거기와 이 표만 고친다.

## 규칙

| 파라미터 | 뜻 | 허용 값 |
|---|---|---|
| `utm_source` | 게시 장소 | 아래 장소 목록 |
| `utm_medium` | 게시 형태 | `post`, `comment`, `readme`, `dm` |
| `utm_campaign` | 캠페인 | `launch_YYYYMM` (예: `launch_202610`). 생략하면 이번 달 |

- `utm_source`·`utm_medium`은 **소문자와 밑줄(`_`)만** 쓴다. 대문자·하이픈·공백·숫자는 스크립트가 거부한다.
- 목록에 없는 값도 스크립트가 거부한다(종료 코드 2, stdout 비어 있음).
- 새 장소가 생기면 `scripts/make_link.py`의 `SOURCES`와 아래 표에 **같이** 추가한다.

### 장소 목록 (`utm_source`)

| 값 | 장소 |
|---|---|
| `geeknews` | GeekNews (news.hada.io) |
| `reddit_claudeai` | Reddit r/ClaudeAI |
| `disquiet` | 디스콰이엇 |
| `study` | 스터디 모임·커뮤니티 |
| `github_readme` | GitHub README |

## 스크립트 사용법

표준 라이브러리만 쓴다(Python 3.8+).

```
python scripts/make_link.py <장소> <매체> <대상> [--campaign launch_YYYYMM]
python scripts/make_link.py --list
```

예시:

```
$ python scripts/make_link.py geeknews post store
https://chromewebstore.google.com/detail/dlifmhanolkjflblnofiifgkffhkpgga?utm_source=geeknews&utm_medium=post&utm_campaign=launch_202610

$ python scripts/make_link.py reddit_claudeai comment releases --campaign launch_202611
https://github.com/donasman/leeway/releases/latest?utm_source=reddit_claudeai&utm_medium=comment&utm_campaign=launch_202611

$ python scripts/make_link.py Reddit post store
error: utm_source 'Reddit' is not allowed (lowercase letters and _ only). allowed: disquiet, geeknews, github_readme, reddit_claudeai, study
```

## 출처를 확인하는 곳

### Chrome Web Store (`store`)

- 스토어 페이지 방문의 출처는 **개발자 대시보드에서 스토어 리스팅에 Google Analytics(GA4)를 켜야** 보인다.
  켜지 않으면 대시보드 통계에는 설치 수만 있고 링크별 유입은 알 수 없다.
- UTM 값이 GA4의 세션 소스·매체·캠페인으로 실제로 잡히는지는 아직 확인하지 않았다.
  **출시 첫 주에** 이 규칙으로 만든 링크를 한 번 열어 보고 GA4 실시간·트래픽 획득 보고서에 `utm_source` 값이 나오는지 확인한다.
  안 나오면 이 문서에 그 사실을 적고 스토어 쪽 72시간 방문 수는 대시보드 수치로 대신한다.

### GitHub (`repo`, `releases`)

- GitHub는 UTM 파라미터를 기록하지 않는다. 링크에 붙여도 해가 없어서 형식을 맞추려고 붙이지만, 출처 구분에는 쓰이지 않는다.
- GitHub 쪽 출처는 **트래픽 API의 유입 사이트(도메인)** 로 구분한다.
  - `GET /repos/donasman/leeway/traffic/popular/referrers` — 최근 14일 상위 10개 유입 도메인(예: `news.hada.io`, `reddit.com`)과 방문·고유 방문자 수.
    저장소 쓰기 권한이 있는 토큰이 필요하다(웹에서는 Insights → Traffic).
  - 14일이 지나면 사라지므로 게시 후 72시간 시점에 기록해 둔다.
  - 도메인 단위라서 같은 사이트의 글과 댓글(`post`/`comment`)은 GitHub 쪽에서 구분되지 않는다.
- helper 다운로드 수는 Releases API의 asset `download_count`로 보지만, 출처는 알 수 없다.

## 게시 기록

게시할 때마다 한 줄 추가하고, 72시간 뒤 방문 수를 채운다. 방문 수에는 어디서 읽은 값인지(GA4 / GitHub Traffic) 메모에 적는다.

| 날짜 | 장소 | 매체 | 링크 | 72시간 방문 수 | 메모 |
|---|---|---|---|---|---|
| | | | | | |
