# Leeway

Claude · ChatGPT · Gemini의 **남은** 사용량(5시간·주간·월간 한도)을 Chrome 팝업, 툴바 배지,
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
- 모든 숫자는 **남은 비율**이다. "사용한 비율"로 뒤집지 않는다.
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
| `extension/background.js` | 서비스 워커. 2분 주기 수집(`POLL_MINUTES`), 저장(`publish`), 배지, Leeway 창 열기, helper 동기화, 메시지 처리 |
| `extension/snapshot.js` | 수집 결과 → 저장할 `UsageSnapshot` 정규화(`toSnapshot`), 다른 프로필 값 재검증(`fromShared`) |
| `extension/view.js` | 저장값 → 팝업·오버레이·배지가 보여줄 값(`providerView`, `badgeView`, `peerViews`) |
| `extension/parsers.js` | 공용 파서, Claude 사용량 버킷, 요금제 라벨(`claudePlanLabel`, `chatgptPlanLabel`) |
| `extension/chatgpt_api.js` | ChatGPT `wham/usage` 응답 → 수집 결과 |
| `extension/chatgpt.js` | ChatGPT Settings > Usage 탭 DOM 파서(API 실패 시 대체 경로) |
| `extension/gemini.js`, `gemini_scan.js` | 열린 gemini.google.com/usage 탭에서 값을 읽어 수집 결과로 |
| `extension/peers.js` | helper로 보낼 값 만들기, helper 응답 해석 |
| `extension/i18n.js` | `chrome.i18n` → view.js용 라벨 맵 |
| `extension/popup.html`, `popup.js` | 팝업 |
| `extension/overlay_window.html`, `overlay_window.js` | Leeway 창(§4). 펼친 오버레이를 보여주고 "항상 위에 띄우기"(포커스가 있어 Enter로도)로 Document Picture-in-Picture 오버레이를 연다. 값은 storage에서 직접 읽고, 자기 창 위치를 저장한다 |
| `extension/overlay_view.js` | 오버레이 그리기(펼침·접힘, CSS, PiP 열기·크기 맞춤). 그리는 HTML과 스타일은 `tests/test_overlay.mjs`가 고정 |
| `extension/_locales/{en,ko,es,ja,zh_CN,zh,zh_TW}` | UI 문자열 6개 언어. 간체 중국어는 `zh_CN`(스토어 표시)과 `zh`(대체용) 두 폴더, 내용은 같게 유지. 번체는 `zh_TW` |
| `helper/` | Leeway helper (Go, 의존성 없음). Native Messaging 호스트, `install`/`uninstall` |
| `tests/` | Node 테스트 (`npm test`), `tests/fixtures/` HTML 픽스처 |
| `docs/index.html`, `docs/ko/index.html` | GitHub Pages 제품 페이지(영어·한국어). 기능·FAQ와 JSON-LD(SoftwareApplication, FAQPage)는 화면 문구와 같게 유지 |
| `docs/privacy/index.html` | GitHub Pages 개인정보처리방침 (`PRIVACY.md`와 같은 내용을 유지) |
| `docs/llms.txt`, `docs/sitemap.xml`, `docs/img/` | 사이트 요약(사실만), 사이트맵, 스크린샷 |
| `.github/workflows/helper-release.yml` | `v*` 태그 → helper 빌드·Release 첨부 |
| `.github/workflows/metrics.yml`, `.github/scripts/collect_metrics.py` | 매일 09:00 KST 출시 지표(트래픽·유입·다운로드·스타) → `metrics` 브랜치 `data/*.csv`. 시크릿·컬럼은 `docs/metrics.md` |

### pure layer

`snapshot.js`, `view.js`, `parsers.js`, `chatgpt_api.js`, `gemini.js`, `peers.js`는 순수 함수만 둔다(`chrome.*`, `fetch`, `document` 없음).
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
- **Gemini**: 사용량 API가 없다. 이미 열린 `gemini.google.com/usage` 탭의 화면 숫자만 읽는다. "현재 사용량"이 `gemini_5h`(대표값), 주간이 `gemini_weekly`.

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

`chrome.storage.session`(브라우저를 닫으면 사라짐): `gemini_open_wait`(아래 Gemini), `overlay_window_id`(열린 Leeway 창 id. 쓰기 전에 `windows.get`으로 살아 있는지 확인하고, 없으면 `runtime.getContexts`로 다시 찾는다).

더 이상 쓰지 않는 키(`background.js`의 `LEGACY_KEYS`, 없앤 127.0.0.1 bridge의 `bridge_token` 포함)는 설치·업데이트 때 `onInstalled`에서 지운다.

### 다국어

UI 문자열은 `_locales/<lang>/messages.json`. 6개 언어가 **같은 키**를 가져야 한다(`tests/test_locales.mjs`가 확인).
간체 중국어는 `zh_CN`(Chrome Web Store가 언어로 표시)과 `zh`(Chrome이 zh-CN 외 중국어 UI에서 대체로 씀) 두 폴더이고, 내용은 같게 유지한다.
간체 문구를 고치면 두 파일을 함께 고친다(`test_locales`가 두 파일이 같은지 확인).
템플릿은 `$1`이 아니라 `{token}`을 쓰고 view.js의 `fill()`이 치환한다. 기간 표기의 간격은 `i18n.js`의 `separatorsFor()`가 언어별로 정한다.

### Gemini

Gemini 값은 그 탭이 열려 있을 때만 갱신된다. 탭이 없으면 마지막 값이 오래됨으로 흐려지거나 `?`가 된다. 이건 버그가 아니라 설계다.

팝업의 "Gemini 사용량" 버튼을 누르면 사용량 탭을 열거나 이미 열린 탭으로 이동하고, 로드 후 자동으로 읽는다(`openGeminiUsage`).
- 이미 열린 사용량 탭은 Gemini가 켜져 있고 호스트 권한이 있을 때만 찾는다(여러 개면 `lastAccessed`가 가장 최근). 채팅 탭은 재사용하지 않는다.
  `tabs` 권한 없이 동작한다: 탭의 `url`은 gemini.google.com 호스트 권한으로 보이고, 다른 사이트로 간 탭은 `url`이 없어 "사용량 화면 아님"이 된다.
- 대기 `{id, tabId, openedAt, phase}`는 `chrome.storage.session`의 `gemini_open_wait`에 하나만 둔다. `tabs.onUpdated`·`onRemoved`는 최상위에서 등록한다.
- `complete` 뒤 2초에 `refreshGemini()`, 현재 카드가 없으면 5초·10초 뒤 다시. 연 지 30초가 지나면 새 읽기를 시작하지 않는다. `complete`가 30초 안에 안 오면 한 번만 읽는다.
- 탭이 닫히거나 사용량 화면을 떠나면 대기를 지운다. Gemini 페이지를 reload하지 않는다. 버튼 없이 탭을 열지 않는다.

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

- 갱신 주기 2분. 마지막 읽기가 **6분**(`STALE_MS`, 갱신 세 번 실패)보다 오래되면 오래됨으로 흐리게 표시한다.
- 실패하면 마지막 정상값을 흐리게 보여주고 "마지막 정상값 · N분 전"을 단다.
- 색 기준(팝업·배지·오버레이 공통): 50 이상 초록, 20~49 주황, 20 미만 빨강, `?`는 색 없음. 배지는 오래되면 회색.
- 배지는 켠 서비스들의 대표값 중 **가장 낮은 값**(숫자만, `%` 없음). 툴팁에 서비스별 한 줄. 다른 프로필 값은 배지에 넣지 않는다.
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
  창 크기는 펼침 폭 280·높이 140~520(내용 맞춤), 접힘 360×44. 제목 표시줄에는 사이트 주소가 아니라 확장 이름과 확장 주소(`chrome-extension://<ID>`)가 보인다(좁으면 잘림). Chrome PiP라서 **제목 표시줄과 사용자 크기 조절은 막을 수 없다.**
  처음 열 때부터 내용 높이로 연다. 여는 Leeway 창 페이지에 보이지 않는 복사본을 폭 280으로 그려 높이를 재고, 그 값을 `requestWindow` 높이로 넘긴다.
  `requestWindow`가 클릭의 활성화를 써 버려서 열린 뒤의 `resizeTo`는 동작하지 않기 때문이다(실측). 클릭할 때의 크기 조절은 그대로다.
  접힘은 Chrome의 PiP 최소 높이 때문에 내용 높이가 44가 아니라 약 58이다(실측, 그대로 둠).

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
- Enter로 PiP 열기(feat/pin-enter, 2026-10-28, Chrome 156, 압축해제 로드한 이 브랜치, 키는 CDP `Input.dispatchKeyEvent`).
  - 확인됨: 팝업의 "오버레이 열기"로 창이 뜨면 포커스가 버튼에 있고(`document.hasFocus()` true), 키를 누르지 않으면 2초 넘게 아무것도 열리지 않음.
  - 확인됨: Enter → PiP 열림·창 최소화. PiP 닫기 → 창 복원·포커스 다시 버튼. Space도 열림. 자동 반복 keydown만으로는 안 열림.
    포커스를 버튼에서 뺀 뒤 "오버레이 열기"로 앞으로 가져와도 포커스가 버튼으로 돌아옴. 창은 1개.
  - 미확인: 실제 키보드(물리 키)와 사용 중인 Chrome 프로필. 다른 앱이 앞에 있을 때 Windows가 새 창에 키보드 포커스를 주는지.

- `tabs` 권한을 뺐다(0.6.3, 2026-10-28 스토어 게시). 실제 Chrome에서 권한, 세 서비스 새로고침, Gemini 버튼, 오버레이 열기를 확인했다(2026-10-27). ChatGPT 대체 경로(설정 > 사용량 탭 읽기)를 `tabs` 없이 실제로 탄 경우와, 0.6.2 → 0.6.3 업데이트 때 재승인 요청이 없었는지는 미확인.
- ChatGPT 페이지 대체 경로(fix/chatgpt-five-hour, 2026-10-28): 한 카드의 %가 없을 때 두 한도가 함께 든 묶음까지 올라가 다른 한도의 값을 가져가던 것을 고쳤다.
  다른 한도의 제목이 든 요소에서 멈추고, 5시간은 제목("5시간 한도"·"5-hour limit")을 먼저 찾는다(주간 카드의 "in 5 hours"를 5시간 제목으로 보지 않음).
  fixture와 jsdom으로만 확인했다. 영어 화면의 실제 문구(예: "Weekly usage limit"면 지금 `WEEK_RE`로는 주간을 못 찾음)는 미확인.
- 실계정으로 확인 못 한 것: ChatGPT 5시간·주간 한도 계정, Claude Pro·Team·Enterprise의 요금제 표기.
- helper: 코드 서명 없음(SmartScreen 경고, Windows 11 Smart App Control은 차단). Microsoft Store(MSIX) 패키지에서 Native Messaging 등록이 Chrome에 보이는지 미확인.
- v0.6.0 태그 때 `helper-release` 워크플로가 실행되지 않았다(원인 미확인). v0.6.1부터는 정상.
