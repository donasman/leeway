# Leeway

Claude · ChatGPT · Gemini의 사용량(5시간·주간·월간 한도. 기본은 사용한 비율, 전환하면 남은 비율)을 Chrome 팝업, 툴바 배지,
항상 위에 뜨는 오버레이로 보여주는 Chrome 확장. 선택 기능은 Windows용 Leeway helper가 맡는다.

- 저장소: https://github.com/donasman/leeway · 사이트: https://donasman.github.io/leeway/ · 개인정보처리방침: https://donasman.github.io/leeway/privacy/
- Chrome Web Store ID `dlifmhanolkjflblnofiifgkffhkpgga` (스토어판)
- 이 문서는 2026-10-27 기준 실제 코드에서 작성했다. 코드 주석의 `CLAUDE.md §n`은 아래 절 번호를 가리킨다.
  절을 고치면 그 번호를 쓰는 주석도 함께 확인한다.

---

## 0. 방향 (2026-10-27 확정)

- **확장만으로 완결된다.** 핵심 기능(팝업·배지·PiP 오버레이·요금제·Claude 조직)은 확장 하나로 다 쓸 수 있어야 한다.
  helper가 없어서 핵심 기능이 안 되는 변경은 하지 않는다.
- **더 쓰고 싶은 사람만 helper를 설치한다.** 확장된 기능(다른 Chrome 프로필 합쳐 보기, 이후 테두리 없는 데스크톱 오버레이 등)은
  helper(`helper/`, Windows exe)로 제공한다. helper 관련 권한(`nativeMessaging`)은 항상 **선택 권한**이고, 사용자가 켤 때만 요청한다.
- **사용자는 웹(Chrome Web Store)으로 먼저 모은다.** helper는 당분간 GitHub Releases로 배포한다.
- 단계별 계획은 [docs/ROADMAP.md](docs/ROADMAP.md).

---

## 1. 제품 원칙 (변경 금지)

- 로그인 자동화를 하지 않는다. 사용자는 평소 쓰는 Chrome에서 직접 로그인하고, 확장은 그 세션으로 사용량만 읽는다.
- 쿠키·비밀번호·세션 토큰을 저장하거나, 기록하거나, 확장 밖으로 보내지 않는다. helper에도 보내지 않는다.
  - Anthropic은 외부 개발자가 Claude.ai 자격증명이나 세션 토큰을 수집·저장·중개하는 것을 허용하지 않는다
    ([Claude Code 법률·규정](https://code.claude.com/docs/en/legal-and-compliance)). Claude Code의 OAuth 토큰을 읽어 쓰는 방식도 같은 이유로 쓰지 않는다.
- 저장·계산·helper로 보내는 숫자는 모두 **남은 비율**이다. 수집이나 저장 단계에서 "사용한 비율"로 뒤집지 않는다.
  화면(팝업·Leeway 창·PiP·배지)만 사용자 설정에 따라 사용한 비율로 그린다(§4. 2026-10-29 사용자 결정으로 이 원칙을 이렇게 고침).
- `0%`는 정상 값이다. 값 없음은 `null`이고 화면에는 `?`로 보인다. 둘을 절대 섞지 않는다
  (`Number('')`처럼 빈 값이 0이 되는 변환 금지).
- 대표값은 **5시간 한도**다. 5시간 한도가 아예 없는 계정(예: ChatGPT Pro)만 주간, 그것도 없으면 월간이 대표값이 된다.
  5시간 한도가 있는데 못 읽었으면 대표값은 `?`이고, 주간 값을 대신 올리지 않는다.
- 전체 페이지 텍스트나 대화 내용은 저장하지 않는다. 진단 정보에도 남기지 않는다.
- 분석·추적·광고 식별자를 넣지 않는다. 자체 서버가 없다.

---

## 2. 구조와 데이터 계약

### 파일

| 경로 | 역할 |
|---|---|
| `extension/manifest.json` | MV3. 필수 권한 `storage alarms scripting`(`tests/test_manifest.mjs`가 고정. `tabs`·`activeTab` 없음), 선택 권한 `nativeMessaging`, 선택 호스트 권한 claude.ai·chatgpt.com·gemini.google.com |
| `extension/background.js` | 서비스 워커. 1분 주기 수집(`POLL_MINUTES`)과 팝업·Leeway 창이 열릴 때의 수집(`REFRESH_IF_OLD`), 저장(`publish`), 배지, Leeway 창 열기, helper 동기화, 메시지 처리 |
| `extension/snapshot.js` | 수집 결과 → 저장할 `UsageSnapshot` 정규화(`toSnapshot`), 다른 프로필 값 재검증(`fromShared`) |
| `extension/view.js` | 저장값 → 팝업·오버레이·배지가 보여줄 값(`providerView`, `badgeView`, `peerViews`). 사용/남은 표시(`percentMode`, `shownPercent`)와 색(`toneOf`)도 여기서만 정한다 |
| `extension/parsers.js` | 공용 파서, Claude 사용량 버킷, 요금제 라벨(`claudePlanLabel`, `chatgptPlanLabel`) |
| `extension/chatgpt_api.js` | ChatGPT `wham/usage` 응답 → 수집 결과 |
| `extension/chatgpt.js` | ChatGPT Settings > Usage 탭 DOM 파서(API 실패 시 대체 경로) |
| `extension/gemini.js`, `gemini_scan.js` | 열린 gemini.google.com/usage 탭에서 값을 읽어 수집 결과로 |
| `extension/peers.js` | helper로 보낼 값 만들기, helper 응답 해석 |
| `extension/i18n.js` | `chrome.i18n` → view.js용 라벨 맵 |
| `extension/popup.html`, `popup.js` | 팝업 |
| `extension/overlay_window.html`, `overlay_window.js` | Leeway 창(§4). 펼친 오버레이를 보여주고 "항상 위에 띄우기"(포커스가 있어 Enter로도)로 Document Picture-in-Picture 오버레이를 연다. 값은 storage에서 직접 읽고, 자기 창 위치를 저장한다 |
| `extension/overlay_view.js` | 오버레이 그리기(펼침·접힘, CSS, PiP 열기, 전환 클릭 때 창 크기 맞춤, 창 크기에 맞춰 그리기). 그리는 HTML과 스타일은 `tests/test_overlay.mjs`가 고정 |
| `extension/overlay_fit.js` | PiP 오버레이의 정한 크기(`pipSize`, `pipOuterSize`)와 창 크기에 따라 그리는 방식(`fitOverlay`: 그릴 모양·축소 비율·이름 표시, §4) |
| `extension/_locales/{en,ko,es,ja,zh_CN,zh,zh_TW}` | UI 문자열 6개 언어. 간체 중국어는 `zh_CN`(스토어 표시)과 `zh`(대체용) 두 폴더, 내용은 같게 유지. 번체는 `zh_TW` |
| `helper/` | Leeway helper (Go, 의존성 없음). Native Messaging 호스트, `install`/`uninstall` |
| `tests/` | Node 테스트 (`npm test`), `tests/fixtures/` HTML 픽스처 |
| `docs/index.html`, `docs/ko/index.html` | GitHub Pages 제품 페이지(영어·한국어). 기능·FAQ와 JSON-LD(SoftwareApplication, FAQPage)는 화면 문구와 같게 유지 |
| `docs/privacy/index.html` | GitHub Pages 개인정보처리방침 (`PRIVACY.md`와 같은 내용을 유지) |
| `docs/llms.txt`, `docs/sitemap.xml`, `docs/img/` | 사이트 요약(사실만), 사이트맵, 스크린샷 |
| `.github/workflows/helper-release.yml` | `v*` 태그 → helper 빌드·Release 첨부 |
| `.github/workflows/metrics.yml`, `.github/scripts/collect_metrics.py` | 매일 09:00 KST 출시 지표(트래픽·유입·다운로드·스타) → `metrics` 브랜치 `data/*.csv`. 시크릿·컬럼은 `docs/metrics.md` |

### pure layer

`snapshot.js`, `view.js`, `parsers.js`, `chatgpt_api.js`, `gemini.js`, `peers.js`, `overlay_fit.js`는 순수 함수만 둔다(`chrome.*`, `fetch`, `document` 없음).
그래야 Node 테스트가 실제 파일을 그대로 불러 쓸 수 있다. `chrome.*`이 필요한 일은 `background.js`·`popup.js`·`overlay_window.js`·`i18n.js`가 한다.

### 수집기 계약

각 서비스의 수집 결과(payload)는 `{provider, status, value, detail, limits[], plan?, accounts?}`이고, `publish()`가 `toSnapshot()`으로 정규화해 저장한다.

- `status`: `ok` | `logged_out` | `parse_failed` | `needs_permission` | `disabled`. `ok`는 **대표값을 읽었을 때만**이다. 아니면 `parse_failed`로 낮춘다.
- `limits[]`: `{id, label, remaining_percent, resets_at, reset_text}`. `id`는 `<provider>_5h` · `_weekly` · `_monthly`.
  - **5시간 한도가 있는 서비스는 못 읽었어도 `claude_5h: null`처럼 항목을 남긴다.** 빠지면 "5시간 한도 없는 계정"으로 읽혀 주간 값이 대표값이 된다.
  - ChatGPT는 창의 이름이 아니라 **길이**(`limit_window_seconds`)로 5시간·주간·월간을 구분한다.
- `plan`: 고정 목록의 짧은 상품명만(`Max 5x`, `Plus` …). 서버 문자열을 그대로 쓰지 않는다. 모르면 넣지 않는다.
- `accounts[]` (Claude만): 로그인 하나에 채팅 조직이 2개 이상일 때 조직별 `{plan, status, limits}`. 첫 조직이 대표(배지·접힌 오버레이). 조직 이름은 읽지 않는다(개인 조직 이름에 이메일이 들어 있음).

서비스별 읽는 곳:

- **Claude**: `claude.ai/api/organizations` → 채팅 조직마다 `/api/organizations/{id}/usage` (최대 4개). 브라우저 세션 쿠키로 요청한다.
- **ChatGPT**: `chatgpt.com/api/auth/session`의 단기 토큰으로 `backend-api/wham/usage`. 토큰은 그 요청에만 쓰고 저장하지 않는다.
  실패하면 이미 열린 Settings > Usage 탭이 있을 때만 DOM에서 읽는다. 탭을 새로 열거나 대화 탭에 주입하지 않는다.
- **Gemini**: 사용량 API가 없다. 이미 열린 `gemini.google.com/usage`(다른 Google 계정이면 `/u/1/usage`) 탭의 화면 숫자만 읽는다. "현재 사용량"이 `gemini_5h`(대표값), 주간이 `gemini_weekly`.

### 저장 키

`chrome.storage.local`:

| 키 | 내용 |
|---|---|
| `enabledProviders` | 켠 서비스 목록. background만 쓴다 |
| `usage_<provider>` | 최신 시도의 스냅샷 (실패 포함) |
| `usage_last_ok_<provider>` | 최신 `ok` 스냅샷. 실패해도 남고, 끄거나 권한이 없어지면 `null` |
| `chatgpt_debug` | ChatGPT 진단(단계·상태 코드만, 토큰·본문 없음) |
| `peer_settings` | `{on, id, label}` — 다른 프로필 기능. `id`는 무작위 16자리 hex |
| `peer_profiles` | 마지막 helper 응답 중 **다른** 프로필들 `{at, ok, error, version, profiles[]}`. `error`는 `helper_missing`·`_forbidden`·`_blocked`·`_failed`, `version`은 `x.y.z`·`dev`·`null`(이 필드가 없는 예전 기록은 버전을 판단하지 않음) |
| `overlay_window_bounds` | Leeway 창을 마지막에 둔 곳 `{left, top, width, height}`. 창(`overlay_window.js`)이 보통 상태일 때만 쓰고(최소화·최대화 제외), background가 창을 열 때 읽는다 |
| `percent_mode` | 숫자 표시 방향 `'used'` 또는 `'remaining'`(§4). 없거나 다른 값이면 `'used'`(`view.js` `percentMode`). 팝업의 전환 버튼이 직접 쓰고, 팝업·Leeway 창·background(배지)가 `onChanged`로 따라간다 |

`chrome.storage.session`(브라우저를 닫으면 사라짐): `gemini_open_wait`·`gemini_reloads`(아래 Gemini), `refresh_started_at`(마지막 수집 라운드 시작 시각, §4), `overlay_window_id`(열린 Leeway 창 id. 쓰기 전에 `windows.get`으로 살아 있는지 확인하고, 없으면 `runtime.getContexts`로 다시 찾는다).

더 이상 쓰지 않는 키(`background.js`의 `LEGACY_KEYS`, 없앤 127.0.0.1 bridge의 `bridge_token` 포함)는 설치·업데이트 때 `onInstalled`에서 지운다.

### 다국어

UI 문자열은 `_locales/<lang>/messages.json`. 6개 언어가 **같은 키**를 가져야 한다(`tests/test_locales.mjs`가 확인).
간체 중국어는 `zh_CN`(Chrome Web Store가 언어로 표시)과 `zh`(Chrome이 zh-CN 외 중국어 UI에서 대체로 씀) 두 폴더이고, 내용은 같게 유지한다.
간체 문구를 고치면 두 파일을 함께 고친다(`test_locales`가 두 파일이 같은지 확인).
템플릿은 `$1`이 아니라 `{token}`을 쓰고 view.js의 `fill()`이 치환한다. 기간 표기의 간격은 `i18n.js`의 `separatorsFor()`가 언어별로 정한다.

### Gemini

Gemini 값은 그 탭이 열려 있을 때만 갱신된다. 탭이 없으면 마지막 값이 오래됨으로 흐려지거나 `?`가 된다. 이건 버그가 아니라 설계다.

열린 사용량 탭을 최신으로 두기(2026-10-28, 사용자 결정):
- 페이지는 로드할 때 숫자를 그리고, 뒤에 있는 동안은 다시 받지 않는 것으로 보인다(사용자 제보, 실제 페이지로는 미확인). 숫자의 나이는 페이지의 "N분 전에 업데이트됨"(`gemini.js` `updatedAgoMs`)이고,
  스냅샷의 `collected_at`은 읽은 시각이 아니라 이 나이를 뺀 시각이다(`publish(payload, collectedAt)`). 오래된 페이지는 오래됨으로 보인다.
- 읽은 탭은 `tabs.update({autoDiscardable: false})`로 메모리 절약 모드가 내리지 않게 한다(`tabs` 권한 불필요, 실측).
- 숫자가 5분(`GEMINI_RELOAD_AFTER_MS`) 넘게 오래됐거나 Chrome이 내리거나(`discarded`) 얼린(`frozen`) 사용량 탭은 **보이지 않을 때만** 새로고침한다.
  보임 = 보이는(최소화 아닌) 창의 활성 탭. 탭마다 5분에 한 번까지(`gemini_reloads`). 새로고침 뒤에는 Gemini 버튼과 같은 대기로 로드 후 읽는다.
  내리거나 얼린 탭을 새로고침할 수 없으면(5분 안에 이미 함) 상세에 "탭이 잠듦"을 남긴다("탭 없음"과 구분).
- 사용량 탭이 여러 개면 현재 카드를 읽은 탭 중 가장 최근 페이지를 쓴다.

팝업의 "Gemini 사용량" 버튼을 누르면 사용량 탭을 열거나 이미 열린 탭으로 이동하고, 로드 후 자동으로 읽는다(`openGeminiUsage`).
- 이미 열린 사용량 탭은 Gemini가 켜져 있고 호스트 권한이 있을 때만 찾는다(여러 개면 `lastAccessed`가 가장 최근). 채팅 탭은 재사용하지 않는다.
  `tabs` 권한 없이 동작한다: 탭의 `url`은 gemini.google.com 호스트 권한으로 보이고, 다른 사이트로 간 탭은 `url`이 없어 "사용량 화면 아님"이 된다.
- 대기 `{id, tabId, openedAt, phase}`는 `chrome.storage.session`의 `gemini_open_wait`에 하나만 둔다. `tabs.onUpdated`·`onRemoved`는 최상위에서 등록한다.
- `complete` 뒤 2초에 `refreshGemini()`, 현재 카드가 없으면 5초·10초 뒤 다시. 연 지 30초가 지나면 새 읽기를 시작하지 않는다. `complete`가 30초 안에 안 오면 한 번만 읽는다.
- 탭이 닫히거나 사용량 화면을 떠나면 대기를 지운다. 새로고침은 위 규칙(보이지 않는 오래된 탭)으로만 한다. 버튼 없이 탭을 열지 않는다.

### Leeway helper

- Chrome이 메시지마다 실행하는 Native Messaging 호스트(`com.leeway.helper`). 받은 값을 `%LOCALAPPDATA%\Leeway\profiles.json` 한 파일에 모은다.
  잠금 파일 + 임시 파일 rename으로 동시 쓰기를 막는다. 프로필 8개, 프로필당 16 KB, 메시지 64 KB, 7일 지나면 삭제.
- 네트워크 요청을 하지 않는다. HKCU에 사용자 단위로 등록한다(관리자 권한 불필요). 실행 파일은 `%LOCALAPPDATA%\Leeway\helper\`로 복사된다.
- 허용 확장 ID는 `helper/main.go`의 `defaultExtensionIDs`: 스토어 `dlifmhanolkjflblnofiifgkffhkpgga`, 개발용 key `nnknbbnoekgbalackpaekkemnjibicia`.
  키 없이 압축해제 로드한 확장은 경로 기반 ID라 `leeway-helper.exe install --extension-id <ID>`로 추가해야 한다.
- 확장 쪽에서 받은 다른 프로필 값은 같은 사용자의 것이어도 **검증 안 된 입력**으로 다룬다(`fromShared`로 재검증, 화면에는 텍스트로만).
- 연결 진단(팝업): Chrome의 `runtime.lastError` 문자열(Chromium `native_message_host.cc`·`message_service.cc`)을
  설치 안 됨·금지됨·정책 차단·실행 실패로 나누고, 상태마다 원인 한 줄과 다음 행동 한 줄을 보여준다(`peers.js` `helperState`).
  정상이면 helper 버전과 마지막 동기화 시각. 원문 오류 문자열은 저장하지 않는다.
- 버전: 릴리스 빌드는 태그에서 `-X main.version`을 받는다(소스 빌드는 `dev`). `MIN_HELPER_VERSION`(`peers.js`)보다 낮으면 업데이트 안내, `dev`는 통과.
- `leeway-helper.exe check`: 레지스트리·manifest·exe 경로·허용 ID·데이터 폴더·`profiles.json`·Chrome 정책·실제 실행(`hello`)을 항목별 OK/FAIL과 고치는 법으로 출력,
  하나라도 실패하면 종료 코드 1. 더블클릭하면 install 뒤 바로 실행. 레지스트리는 `registry` 인터페이스 뒤라 Windows 밖에서도 `go test`가 돈다.

---

## 3. 보안·개인정보

- 호스트 권한은 서비스별 **선택 권한**이다. 서비스를 켤 때 요청하고, 끄면 반납한다. `<all_urls>` 금지.
- `tabs` 권한은 쓰지 않는다(설치 시 "방문 기록 읽기" 경고). 사용량 탭의 `url`은 승인된 호스트 권한으로 보인다. 팝업은 활성 탭을 보지 않는다.
  권한이 없는 탭은 `url` 없이 오므로 `url`로 거르는 코드는 그 탭을 건너뛴다.
- 콘텐츠 스크립트는 각 서비스의 **사용량 화면에만** 주입한다. 대화 탭에는 주입하지 않는다.
  오버레이를 위해 현재 탭에 주입하지 않는다. 오버레이는 확장 페이지인 Leeway 창이 연다(§4).
- background는 확장 페이지(팝업, Leeway 창)의 메시지에만 답한다. 웹페이지나 콘텐츠 스크립트가 보낸 메시지는 무시한다.
- 토큰·쿠키는 함수 변수 안에서만 쓰고 저장·로그·진단·helper 어디에도 넣지 않는다. 오류 메시지도 헤더를 인용할 수 있으니 오류 이름만 남긴다.
- `detail`이나 진단에 들어가는 URL은 origin만 남긴다(대화 ID 노출 방지).
- 서버에서 온 문자열(라벨, 리셋 문구, 다른 프로필 이름)은 화면에 **텍스트로만** 넣는다. 오버레이는 `esc()`를 거친다.
- 개인정보 처리 방식이 바뀌면 `PRIVACY.md`와 `docs/privacy/index.html`을 **둘 다** 고친다. 기능이 바뀌면 제품 페이지 두 개와 `docs/llms.txt`, README 첫 부분도 맞춘다. 스토어 대시보드의 개인정보 탭도 맞춘다.

---

## 4. 표시 규칙

- 갱신 주기 1분(`POLL_MINUTES`, 1.0.0까지 2분). 팝업과 Leeway 창은 열릴 때(창이 앞으로 오거나 복원될 때 포함) `REFRESH_IF_OLD`를 보내고,
  background는 마지막 라운드가 30초(`ROUND_FRESH_MS`)보다 오래됐으면 바로 한 라운드 읽는다.
- 마지막 읽기가 **6분**(`STALE_MS`)보다 오래되면 오래됨으로 흐리게 표시한다. Gemini는 페이지가 말하는 숫자의 나이로 잰다.
- 실패하면 마지막 정상값을 흐리게 보여주고 "마지막 정상값 · N분 전"을 단다.
- 숫자 표시(2026-10-29 사용자 결정): 팝업 머리글의 `사용 | 남음` 전환. **기본은 사용**(`percent_mode`, §2). 한 설정이 팝업·Leeway 창·PiP·배지·툴팁·다른 프로필 값에 모두 적용된다.
  - 사용 = `100 - 반올림한 남은 비율`(`shownPercent`). 두 값의 합은 늘 100이고, 남은 0은 사용 100%, `?`는 그대로 `?`.
  - 막대·링 길이는 보이는 숫자를 따른다(사용이면 쓸수록 차오름). 색은 어느 쪽이든 **남은 비율**로 정한다(`toneOf`).
  - 어느 쪽인지 화면에 적는다: 팝업 안내문(`note_main_used`/`note_main`), 툴팁(`badge_pct_used`/`badge_pct`), 펼친 오버레이 머리글의 작은 글자(`mode_used`/`mode_left`). 접힌 PiP에는 자리가 없어 적지 않는다.
- 색 기준(팝업·배지·오버레이 공통, 남은 비율 기준): 50 이상 초록, 20~49 주황, 20 미만 빨강, `?`는 색 없음. 사용으로 보이면 50 이하 초록, 51~80 주황, 81 이상 빨강. 배지는 오래되면 회색.
- 배지는 켠 서비스들의 대표값 중 **남은 값이 가장 낮은 것**(숫자만, `%` 없음). 사용 표시면 그 서비스의 사용한 비율(가장 많이 쓴 값)이다. 툴팁에 서비스별 한 줄. 다른 프로필 값은 배지에 넣지 않는다.
- 오버레이는 **Leeway 창이 연다.** 팝업의 "오버레이 열기"는 어느 탭에서나(웹 스토어·`chrome://`·새 탭 포함) 같은 동작이다.
  background가 Leeway 창(확장 페이지, `type: 'popup'` 창)을 열거나, 이미 열려 있으면 새로 만들지 않고 앞으로 가져온다(최소화돼 있으면 복원).
  버튼을 누르지 않으면 창도 PiP도 열지 않는다(설치 직후 포함).
  - Leeway 창은 펼친 오버레이를 보여준다(다른 창에 가려질 수 있는 일반 창. 클릭해도 접히지 않음). 위에 "항상 위에 띄우기"(1.0.0까지는 "항상 위로"), 아래에 "이 창을 닫으면 항상 위 오버레이도 닫힙니다".
  - "항상 위에 띄우기" → Document PiP를 열고 Leeway 창을 최소화한다. PiP가 이미 열려 있으면 새로 열지 않고 창만 다시 최소화한다.
  - 창이 열리거나 앞으로 오거나 복원될 때마다(창 `focus`) 이 버튼에 포커스를 둔다. "오버레이 열기" 다음 Enter·Space로 PiP가 열린다.
    팝업의 클릭으로 PiP까지 열 수는 없다: `requestWindow`는 그 페이지(Leeway 창) 안의 사용자 동작이 필요하고, 팝업의 클릭은 넘어오지 않는다.
    팝업은 포커스를 잃으면 닫혀서 PiP를 여는 페이지가 될 수 없다. 키를 누른 채 창이 열리면 들어오는 자동 반복(`repeat`)은 무시한다.
  - PiP를 닫으면(X, "탭으로 돌아가기" 버튼, Chrome이 닫은 경우 모두) Leeway 창이 복원된다. **Leeway 창을 닫으면 PiP도 닫힌다.** `disallowReturnToOpener`는 기본값(돌아가기 버튼 보임)이다.
  - Leeway 창은 마지막 위치·크기로 연다. Chrome이 거부하면(화면에 50% 미만, Chrome 102+) 위치 없이 기본 크기 320×480으로 한 번 더 연다.
  - 오래됨과 "N분 전"은 그릴 때마다 시계로 계산한다. 창이 최소화돼 30초 타이머가 늦어져도 값은 맞고, 바뀌는 시점만 늦을 수 있다.
- 오버레이(PiP): 펼침은 서비스별 블록(이름·요금제·큰 숫자·막대·보조 줄), 접힘은 서비스별 링·이름·값 한 줄. 클릭하면 바뀐다.
  정한 크기(`overlay_fit.js`): 펼침은 폭 280, 높이는 내용에 맞추되 최소 140이고 상한은 없다. 접힘은 360×58.
  2026-10-30에 세로 스크롤을 없애면서 520 상한을 뺐다.
  제목 표시줄에는 사이트 주소가 아니라 확장 이름과 확장 주소(`chrome-extension://<ID>`)가 보인다(좁으면 잘림). Chrome PiP라서 제목 표시줄은 없앨 수 없다.
  - 창 크기를 정한 크기로 맞추는 때는 **열 때와 펼침/접힘 전환 클릭 때뿐**이다(2026-10-30 사용자 결정).
    - 처음 열 때부터 내용 높이로 연다. 여는 Leeway 창 페이지에 보이지 않는 복사본을 폭 280으로 그려 높이를 재고, 그 값을 `requestWindow` 높이로 넘긴다.
    - `preferInitialWindowPlacement: true`라서 다시 열어도 정한 크기로 열린다(Chrome 130+). 위치는 기억하지 않고 화면 오른쪽 아래에 열린다.
    - `requestWindow`가 클릭의 활성화를 써 버리므로, 열린 직후의 `resizeTo`는 `NotAllowedError`로 거부된다(실측). 그래서 연 직후에는 부르지 않는다.
    - 전환 클릭은 그 클릭의 활성화로 `resizeTo`한다. 넘기는 바깥 크기 = 정한 크기 + (outer − inner)이고, 가로·세로를 둘 다 잰다.
      Windows에서는 좌우의 보이지 않는 테두리 때문에 가로도 붙는다. 100%에서 16×42, 150%에서 15×41(흉내로는 14×42)이었다. 반올림이 달라서 매번 잰다.
  - 사용자가 테두리를 끌어 크기를 바꾸는 것은 막을 수 없고, 되돌리지도 않는다.
    테두리 드래그에는 사용자 활성화가 없어서 그 뒤의 `resizeTo`가 `NotAllowedError`로 거부된다(실측). 그래서 자동 되돌리기는 넣지 않는다(2026-10-30 사용자 결정).
    대신 내용은 창 크기와 상관없이 정한 크기로 그린다(`fitOverlay`, PiP에만 붙는 `FIT_CSS`). 고른 펼침/접힘(사용자가 클릭으로 정한 값)은 바꾸지 않고, 그리는 모양만 바꾼다.
    - 창이 정한 크기 이상이면 그대로 그린다(확대하지 않는다). 펼침은 왼쪽 위, 접힘 줄은 세로 가운데에 놓고, 남는 곳은 같은 배경색이다. 세로 스크롤은 없다.
    - 창이 정한 크기보다 작으면 `min(가로 비, 세로 비)`로 줄인다.
      하한은 가장 작은 글자가 10px 아래로 내려가지 않는 비율이다. 펼침은 10/10.5(상태 칩 9.5px는 원래 크기에서도 10px보다 작아서 뺐다), 접힘은 10/12.
    - 펼침이 하한으로도 안 들어가면 접힘 줄로 그린다. 접힘 줄도 하한으로 폭이 모자라면 서비스 이름을 빼고 링과 값만 그린다. 이때는 필요한 만큼 더 줄이고, 잘리는 곳은 없다.
    - 한 번 물러난 모양은 8px(`FIT_MARGIN`) 여유가 생기거나 창이 정한 크기가 되어야 돌아온다. 경계에서 깜빡이지 않게 하려는 것이다.
  - 값이 바뀌어 내용 크기가 달라져도(서비스를 켜거나 끔, 조직 수) 창은 그대로 두고 위 규칙으로 그린다. 창 크기는 다음 전환 클릭 때 맞춰진다.
  - 접힘 높이가 58인 이유: `resizeTo`로는 내용 높이가 58 아래로 내려가지 않는다(실측. 테두리 드래그로는 52까지 내려간다).

---

## 5. 테스트와 작업 규칙

- **테스트는 실제 소스를 불러 실행한다. 소스를 테스트에 복사하지 않는다.** `chrome.*`은 테스트마다 메모리 스텁으로 대신한다.
- 파서·수집 동작을 바꾸기 전에 현재 동작을 fixture나 테스트로 먼저 고정한다. `0%` 케이스와 값 없음 케이스는 따로 둔다.
- 변경 후 매번:
  1. `npm test` (전체 통과)
  2. `node --check extension/*.js`
  3. manifest JSON 파싱 + MV3 필수 필드
  4. helper를 고쳤으면 `cd helper && go vet ./... && go test ./...`
- 실제로 실행해서 확인하지 못한 것은 확인했다고 쓰지 않는다. "미확인"으로 남긴다.
- 관련 없는 기존 변경을 되돌리지 않는다. 동작하는 수집 코드를 대규모로 다시 쓰기 전에 테스트로 고정한다.
- 계정 작업(스토어 제출, GitHub 설정, 결제)은 하지 않고 절차를 설명한다.
- Windows에서 연결된 폴더를 통해 테스트하면 jsdom 로딩이 매우 느릴 수 있다. 느리면 로컬 복사본에서 돌린다.

---

## 6. 릴리스 절차

1. `extension/manifest.json`의 `version`을 올린다. 스토어는 이전에 올린 버전보다 높아야 받는다.
2. §5 검증을 모두 통과시킨다.
3. `main`에 합치고 태그를 붙여 push: `git tag -a vX.Y.Z -m "..." && git push origin main vX.Y.Z`
   - `helper-release` 워크플로가 `helper/`를 빌드해 그 Release에 `leeway-helper.exe`와 `.sha256`을 붙인다.
     팝업의 "helper 받기"는 `releases/latest/download/leeway-helper.exe`이므로 **모든 릴리스에 helper가 붙어 있어야 한다.**
4. `extension/` 폴더 **안의 내용**을 zip으로 만든다. zip 안 경로는 `/`여야 한다(Windows 탐색기 압축은 `\`가 들어갈 수 있음).
5. 스토어 대시보드 → 패키지 → 새 패키지 업로드 → 제출. 권한이나 데이터 처리가 바뀌었으면 개인정보 탭과 설명도 맞춘다.
   심사 중에는 새 패키지를 못 올린다. 바꾸려면 "리뷰 취소"(게시 취소 아님) 후 다시 올린다.

---

## 7. 알려진 과제

- `activeTab`을 뺐다(0.6.4, chore/drop-activetab, 2026-10-28). feat/overlay-window 이후로 쓰는 곳이 없었다. 0.6.4는 스토어에 올리지 않았으므로 1.0.0을 제출할 때 스토어 개인정보 탭에서 activeTab 사유를 지우고, `scripting` 사유에서 오버레이 문구를 지운다.
- Leeway 창·PiP(feat/overlay-window). 2026-10-28 Windows 11에서 자동화로 실측했다. 별도 프로필의 Chrome 156과 Chrome for Testing 156을 쓰고, CDP 클릭(사용자 활성화 있음)과 Windows API·UI Automation으로 확인했다.
  확장은 claude.ai 권한을 manifest에 넣은 테스트 사본이고, 값은 storage에 넣었다.
  - 확인됨: 설치 직후 창 없음. 웹 스토어·새 탭·`chrome://extensions`·일반 사이트·claude.ai에서 모두 그 탭 앞에 창이 뜸. 두 번 연속 눌러도 창 1개. 최소화 뒤 누르면 같은 창 복원.
  - 확인됨: "항상 위로"로 PiP가 열림(topmost, 다른 앱 창 위). 창 최소화. PiP가 열린 채 다시 눌러도 같은 PiP. 최소화 상태에서 storage 변경이 둘 다에 1.5초 안에 반영.
  - 확인됨: PiP "닫기"·"탭으로 돌아가기" → 창 복원. 창 "닫기" → PiP도 닫힘. 옮기기만 해도 위치 저장, 다시 열면 같은 위치·크기. 화면 밖 위치는 기본 크기로 다시 열림. popup 창 최소 178×95.
  - 확인됨: 다른 페이지의 동영상 PiP와는 하나만 뜬다. "항상 위로"가 그것을 닫고, 그것이 열리면 우리 PiP가 닫히고 창이 복원된다.
  - 확인됨: Chrome 재시작(이전 세션 계속)에서 Leeway 창은 복원되지 않음(Chrome for Testing). 저장된 id 없이도 `getContexts`가 popup 창 안 페이지를 `TAB`·그 창 id로 찾음.
  - 확인됨: 창을 8분 넘게 최소화해도 30초 타이머 지연·freeze·discard 없음. 오래됨은 6분 뒤 첫 tick(6분 23초)에 둘 다 표시됐다. 단, CDP가 붙은 상태라 일반 Chrome도 같은지는 미확인.
  - 150%는 `--force-device-scale-factor=1.5`로 흉내 내서만 봤고, 보조 모니터 분리는 화면 밖 좌표로만 흉내 냈다. 실제 계정 값과 사용 중인 Chrome 프로필에서는 미확인.
  - 처음 여는 크기: 고치기 전에는 요청한 280×270 그대로 열렸다. 고친 뒤에는 서비스 3개일 때 280×202(내용 202, 스크롤 없음), 1개일 때 280×140(최소값)으로 열린다(Chrome for Testing 156).
  - main(현재 탭 주입)과의 크기 비교는 자동화로 PiP가 열리지 않아 못 했다. 접힘 높이는 크기 코드가 같으니 전에도 같았을 것으로 보지만 미확인.
- PiP 크기 고정(feat/overlay-fixed-size, 2026-10-30). 측정 환경: Windows 11, 1920×1080, 배율 100%. 별도 프로필의 Chrome 156.0.8078.49를 썼다.
  두 가지로 확인했다. 하나는 저장소 밖의 실측용 임시 확장(`leeway-probe-pip`, 결과는 `results/RESULTS.md`)이다.
  다른 하나는 이 브랜치의 테스트 사본이다(manifest에 호스트 권한을 넣고, background는 빈 파일, 값은 storage에 넣음).
  버튼은 CDP 클릭으로, 테두리 드래그와 PiP 안 클릭은 Windows `SendInput`(실제 마우스)으로 했다.
  - 확인됨: 테두리를 끄는 동안 resize가 마우스 이동마다 온다(약 60ms 간격). 놓은 뒤에는 따로 오지 않는다.
  - 확인됨: 드래그에는 활성화가 없다. 그 뒤의 `resizeTo`는 즉시 불러도, 300ms 뒤에 불러도 `NotAllowedError`이다.
    PiP 안을 클릭한 지 몇 초 안이면(Chrome 활성화 유지 5초) 그 클릭의 활성화로 한 번은 된다.
  - 확인됨: Chrome PiP 최소 inner는 240×52이다. 최대는 화면의 0.8(1536×864, 제목 표시줄 포함)이다. `resizeTo`로 줄일 수 있는 최소 높이는 58이다.
    Leeway 창(opener)을 클릭해도 PiP에 활성화가 생긴다(Chrome 127+ 공유).
  - 확인됨: `preferInitialWindowPlacement` 없이 다시 열면 마지막 크기·위치로 열린다(X로 닫아도 같음). 옵션이 있으면 요청한 크기로 화면 오른쪽 아래에 열린다.
  - 확인됨(이 브랜치, 실제 CSS, 서비스 3개):
    - 열면 280×250이다. 끌어 키워도 280×250 그대로 왼쪽 위에 있다.
    - 폭 270이면 0.964배로 줄어든다. 270×190이면 이름 없는 줄이 세로 가운데에, 470×190이면 이름 있는 줄이 놓인다. 240×52면 이름 없는 줄이 0.897배로 줄어든다. 어느 경우에도 스크롤은 없다.
    - 전환 클릭은 360×58과 280×250으로 정확히 맞춘다.
    - 접은 상태에서 끌면: 560×208에서는 줄이 그대로 세로 가운데에 있다. 폭 330이면 0.917배로 줄어든다. 폭 270이면 이름 없는 줄이 되고, 240×52면 이름 없는 줄이 0.897배로 줄어든다. 그 상태에서 클릭하면 펼쳐지며 280×250이 된다.
    - 서비스 수를 바꿔도 창은 그대로다. X로 닫고 다시 열면 280×250이다.
    - 예전 코드는 가로 테두리 16을 빼먹어서 펼칠 때 inner 폭이 264가 됐을 것이다. 이것은 계산으로만 본 것이다.
  - 확인됨(실제 Windows 배율 150%, Chrome 156, 측정 뒤 100%로 되돌림):
    - 반올림 때문에 1px씩 어긋난다(열 때 281×250, 접힘 361×59).
    - 펼침·접힘에서 끌기(크게, 좁게, 낮게, 240×52), 전환 클릭, 서비스 수 변경, X로 닫고 다시 열기는 모두 100%와 같았다. 줄인 글자도 선명하다.
    - `--force-device-scale-factor=1.5`로 흉내 낸 결과와도 같았다.
  - 투명도: html·body를 `transparent`나 `rgba(0,0,0,0.5)`로 해도 뒤가 비치지 않는다(흰 바탕이나 회색으로 그려짐). 구현하지 않았다.
  - Chrome 129 이하에는 `preferInitialWindowPlacement`가 없다(130+). 그래서 다시 열 때 마지막 크기·위치로 열릴 수 있다. 그 경우에도 내용은 §4 규칙으로 그린다.
    `minimum_chrome_version`은 넣지 않았다(2026-10-30 결정).
  - 확인됨: PiP를 500×410으로 키우고 옮긴 채 Chrome을 닫았다가 같은 프로필로 다시 띄웠다. PiP는 저절로 열리지 않았다.
    "항상 위에 띄우기"를 누르면 280×250으로 화면 오른쪽 아래에 열렸다.
  - 미확인: 다른 모니터, 사용 중인 Chrome 프로필, 내용이 화면보다 높을 때 Chrome이 자르는 모양.
- Enter로 PiP 열기(feat/pin-enter, 2026-10-28, Chrome 156, 압축해제 로드한 이 브랜치, 키는 CDP `Input.dispatchKeyEvent`).
  - 확인됨: 팝업의 "오버레이 열기"로 창이 뜨면 포커스가 버튼에 있고(`document.hasFocus()` true), 키를 누르지 않으면 2초 넘게 아무것도 열리지 않음.
  - 확인됨: Enter → PiP 열림·창 최소화. PiP 닫기 → 창 복원·포커스 다시 버튼. Space도 열림. 자동 반복 keydown만으로는 안 열림.
    포커스를 버튼에서 뺀 뒤 "오버레이 열기"로 앞으로 가져와도 포커스가 버튼으로 돌아옴. 창은 1개.
  - 미확인: 실제 키보드(물리 키)와 사용 중인 Chrome 프로필. 다른 앱이 앞에 있을 때 Windows가 새 창에 키보드 포커스를 주는지.
- 갱신 1분·열 때 읽기·Gemini 탭 최신 유지(fix/refresh-gemini, 2026-10-28). 계기: 다른 사용자 제보 "Gemini 탭이 열려 있는데 15시간 전", 사용량 페이지에 2분쯤 머물자 최신이 됨.
  실제 Chrome 156에 이 브랜치의 테스트 사본(manifest에 gemini.google.com 권한)을 넣고, `--host-resolver-rules`로 gemini.google.com을
  로컬 HTTPS(자체 서명)로 돌려 저장소 fixture에 "N분 전에 업데이트됨"을 바꿔 넣어 확인했다. 실제 Google 사이트에는 접속하지 않았다.
  - 확인됨: 알람 주기 1분. 뒤에 있는 탭이 "9분 전" → 나이 9분으로 저장, `autoDiscardable` false, 한 번 새로고침, 로드 뒤 다시 읽어 나이 0.
  - 확인됨: 보이는 탭(활성)은 "9분 전"이어도 새로고침하지 않고 나이 9분으로 보임. `tabs.discard`로 내린 탭은 새로고침 뒤 읽힘(내리면 탭 id가 바뀜).
  - 확인됨: `REFRESH_IF_OLD`는 라운드 직후엔 읽지 않고, 31초 뒤엔 읽음.
  - 미확인: 실제 gemini.google.com이 뒤에 있을 때 정말 다시 받지 않는지, 보이면 스스로 갱신하는지(제보와는 맞음). 영어 화면의 "업데이트됨" 문구.
    메모리 절약 모드가 `autoDiscardable: false` 탭을 실제로 건너뛰는지, 얼린 탭의 새로고침. 제보 당시 원인(내려간 탭인지, 오래된 페이지인지).
- 사용/남은 전환(feat/used-percent, 2026-10-29). Node·jsdom 테스트로 확인했다(기본 사용, 전환·유지, 색과 막대, 배지·툴팁, Leeway 창·PiP가 바로 따라감).
  - 확인됨(2026-10-29, Chrome 156 headless, 실제 popup.html·오버레이 코드와 chrome.* 대역): 팝업 머리글이 6개 언어 × 밝은/어두운 모드 × 사용/남음 선택 모두 한 줄에 들어감(가장 긴 es "Usado | Restante").
    스토어 스크린샷의 팝업과 펼친·접힌 오버레이가 사용 기준 숫자, 남은 양 기준 색, 머리글 "Used"로 그려짐(저장소 밖 `leeway-store-1.1.0/gen/`).
  - 미확인: 설치한 확장(사용 중인 Chrome 프로필)에서 전환하면 배지가 바로 바뀌는지.
  - 새 문구 5개 키(`mode_used`·`mode_left`·`mode_aria`·`note_main_used`·`badge_pct_used`)는 6개 언어 모두 원어민 검토 전.
  - 1.0.0 이하에서 올라오는 사용자도 키가 없어 **사용**으로 바뀐다(숫자가 뒤집혀 보임). 사용자가 아직 적어 그대로 두기로 했다(2026-10-29). 안내문과 머리글 전환으로만 알린다.

- `tabs` 권한을 뺐다(0.6.3, 2026-10-28 스토어 게시). 실제 Chrome에서 권한, 세 서비스 새로고침, Gemini 버튼, 오버레이 열기를 확인했다(2026-10-27). ChatGPT 대체 경로(설정 > 사용량 탭 읽기)를 `tabs` 없이 실제로 탄 경우와, 0.6.2 → 0.6.3 업데이트 때 재승인 요청이 없었는지는 미확인.
- ChatGPT 페이지 대체 경로(fix/chatgpt-five-hour, 2026-10-28): 한 카드의 %가 없을 때 두 한도가 함께 든 묶음까지 올라가 다른 한도의 값을 가져가던 것을 고쳤다.
  다른 한도의 제목이 든 요소에서 멈추고, 5시간은 제목("5시간 한도"·"5-hour limit")을 먼저 찾는다(주간 카드의 "in 5 hours"를 5시간 제목으로 보지 않음).
  fixture와 jsdom으로만 확인했다. 영어 화면의 실제 문구(예: "Weekly usage limit"면 지금 `WEEK_RE`로는 주간을 못 찾음)는 미확인.
- 실계정으로 확인 못 한 것: ChatGPT 5시간·주간 한도 계정, Claude Pro·Team·Enterprise의 요금제 표기.
- helper: 코드 서명 없음(SmartScreen 경고, Windows 11 Smart App Control은 차단). Microsoft Store(MSIX) 패키지에서 Native Messaging 등록이 Chrome에 보이는지 미확인.
- v0.6.0 태그 때 `helper-release` 워크플로가 실행되지 않았다(원인 미확인). v0.6.1부터는 정상.
