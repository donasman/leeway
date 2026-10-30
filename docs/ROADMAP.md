# Leeway 로드맵

2026-10-27 정한 방향: **확장만으로 완결되고, 더 쓰고 싶은 사람만 helper를 설치한다. 사용자는 웹(Chrome Web Store)으로 먼저 모은다.**
원칙과 구조는 [CLAUDE.md](../CLAUDE.md).

## 현재 위치 (2026-10-30)

| 항목 | 상태 |
|---|---|
| 스토어 게시 버전 | **1.1.0** (2026-10-30 게시). 1.0.0(2026-10-29 게시, 스토어 페이지 기준 사용자 8명). 0.6.3(2026-10-28 게시). 0.6.2(2026-10-27 게시): 요금제 표시, Claude 조직별 사용량, 실험 기능 "다른 Chrome 프로필", 새 오버레이 디자인 |
| 0.6.3에 들어간 것 | `tabs` 권한 제거, Gemini 사용량 버튼(열린 탭으로 이동·로드 후 자동으로 읽기), helper 연결 진단, 오버레이 크기 고정, 간체 중국어 `zh_CN`, 스토어 설명 6개 언어, 스토어 개인정보 공개 항목 정정(웹사이트 콘텐츠·인증 정보), 개인정보처리방침 URL `/privacy/` |
| 0.6.4 | 태그와 helper Release만 냈다(2026-10-28). 스토어에는 올리지 않고 1.0.0으로 넘어간다 |
| 1.0.0에 들어간 것 | 0.6.4 내용: 오버레이를 Leeway 창(확장 페이지)에서 연다(웹 스토어·`chrome://`·새 탭에서도 열림, PiP 제목 표시줄에 사이트 주소 대신 확장 이름), PiP가 처음부터 내용 높이로 열림, `activeTab` 권한 제거. 1.0.0에서 더한 것: ChatGPT 대체 경로 수정(한 카드의 %가 없을 때 다른 한도의 값을 가져가던 것), 새 스토어 스크린샷 3장과 작은 프로모션 타일(저장소 밖에 준비). helper는 태그를 따라 1.0.0이 된다 |
| 1.1.0에 들어간 것 | 갱신 1분 + 팝업·Leeway 창을 열 때 바로 읽기. Gemini 사용량 탭을 최신으로(내려가지 않게, 뒤에 있고 숫자가 5분 넘게 오래되면 새로고침, 숫자의 실제 나이 표시, `/u/1/usage`). Leeway 창 버튼 이름 "항상 위에 띄우기"(영어 "Float on top"), 창이 뜨면 이 버튼에 포커스 → "오버레이 열기" 다음 Enter로 PiP. 팝업 클릭 한 번으로 PiP까지 여는 것은 Chrome 규칙상 불가. 팝업 머리글의 `사용 | 남음` 전환(기본 사용). 1.0.1로 준비하다가 이 전환이 들어가 1.1.0으로 낸다(2026-10-29 결정). 소개 문구도 사용 기준으로 바꿈 |
| 1.1.0에 함께 바꾼 것 | 패키지 `leeway-1.1.0.zip`(태그 v1.1.0), 스크린샷 3장(사용 기준)·작은 프로모션 타일·6개 언어 상세 설명(저장소 밖 `leeway-store-1.1.0/`) |
| 1.2.1에 들어갈 것 | PiP가 자기 크기를 지킨다(창을 끌어 바꿔도 내용은 정한 크기로 그리고, 크기는 열 때와 펼침/접힘 전환 클릭 때만 맞춘다). 접힌 PiP 폭이 켜진 서비스 수에 맞는다(360 고정 해제). 후원 링크(GitHub Sponsors·Buy Me a Coffee — 저장소·제품 페이지 두 개·README·`docs/llms.txt`와 팝업 맨 아래 텍스트 링크 1개). 팝업의 후원 줄은 `후원하기: GitHub Sponsors · Buy Me a Coffee` 한 줄이고, 6개 언어 모두 한 줄에 들어가는 것을 실제 렌더링으로 쟀다(가장 빠듯한 ko가 여유 26px. 재는 도구는 저장소 밖 `leeway-store-1.2.1/gen/measure-support.mjs`). `manifest.json` 1.2.1(2026-10-30) |
| 1.2.0 | 태그와 helper Release만 냈다(2026-10-30, v1.2.0). 스토어에는 올리지 않고 1.2.1로 넘어간다 — 확장 안 후원 줄에 Buy Me a Coffee를 더하기로 해서다. 태그와 Release는 공개돼 있어 내용을 바꿔 다시 태그하지 않는다(0.6.4와 같은 처리) |
| 심사 중 | **1.2.1** (2026-10-30 제출). 패키지 `leeway-1.2.1.zip`(태그 v1.2.1), 스크린샷 3장을 함께 교체(저장소 밖 `leeway-store-1.2.1/`). 상세 설명 6개 언어와 개인정보 탭은 1.1.0 그대로 두었다. 게시되면 "스토어 게시 버전"을 1.2.1로 |
| helper | v1.1.0 Releases (2026-10-29. `check` 명령, 버전은 태그에서. 코드는 v0.6.3과 같음), 서명 없음 |
| 사이트·검색 | donasman.github.io/leeway (영어·한국어·개인정보처리방침). Google Search Console·Bing Webmaster Tools 등록, 첫 페이지·`/ko/` 색인 요청. Bing 사이트맵 성공, Google 사이트맵은 처리 대기(2026-10-27 기준). 소개 문구를 사용 기준으로 갱신(2026-10-29, v1.1.0 push로 게시) |
| 지표 | `metrics` 워크플로가 매일 GitHub 트래픽·유입·다운로드·스타를 기록(`docs/metrics.md`). 홍보 링크는 `scripts/make_link.py`로 만든다(`docs/tracking-links.md`) |

---

## 1단계 — 확장 다듬기와 사용자 모으기 (지금)

목표: 스토어 설치와 유지(제거되지 않음)를 늘린다. helper 기능은 실험 기능으로 두고 늘리지 않는다.

- [x] 0.6.2 승인(2026-10-27) → 0.6.3 제출·게시(2026-10-28)
- [x] 1.0.0 게시(2026-10-29) → 1.1.0 제출(2026-10-29, 심사 중)
- [x] bridge 잔재 제거 (`background.js`의 `127.0.0.1:8765` 관련 코드와 테스트)
- [x] `tabs` 권한 제거 — 0.6.3에 포함. 설치 시 "방문 기록 읽기" 경고가 없어졌다. 실제 Chrome에서 권한, 세 서비스 새로고침, Gemini 버튼, 오버레이를 확인했다(2026-10-27)
- [x] README 한국어 라벨, `popup.html` `lang`, `package.json` `name` 정리
- [x] 스토어 등록정보 다국어: 한국어·일본어·중국어(간체·번체)·스페인어 설명 (0.6.3과 함께 제출)
- [x] 스토어 스크린샷 갱신: 팝업, 펼친 오버레이, 접힌 오버레이 (지금 것은 0.5.0 화면). 새 3장(팝업, 오버레이 펼침·접힘, 개인정보)은 실제 확장 화면을 데모 값으로 그려 준비했다. 1.1.0 화면(사용 기준, 팝업에 v1.1.0)으로 다시 그렸다(저장소 밖 `leeway-store-1.1.0/`). 1.1.0 제출 때 올렸다(2026-10-29)
- [x] 소개 문구를 기본 "사용"에 맞춤(2026-10-29): README, 제품 페이지 두 개(JSON-LD·FAQ 포함, "남은 비율로 볼 수 있나요?" 질문 추가), `docs/llms.txt`, 개인정보처리방침 두 곳(설정 저장 항목 추가), 스토어 요약(`appDesc` 6개 언어)과 중국어 앱 이름("剩余" 뺌). 스토어 상세 설명(6개 언어)과 스크린샷은 저장소 밖 `leeway-store-1.1.0/`
- [x] 작은 프로모션 타일(440×280) 업로드 — 없으면 검색 결과에서 타일이 있는 확장 뒤에 나온다(Chrome Web Store "Supplying Images" 문서). 시안을 1.1.0 제출 때 함께 올렸다(2026-10-29)
- [x] ChatGPT 페이지 대체 경로 버그 수정: 5시간 %가 없으면 주간 값을 5시간 값으로 보여 주던 것(반대 방향 포함). fix/chatgpt-five-hour, 1.0.0에 포함(2026-10-29 게시)
- [ ] 실계정 확인: ChatGPT 5시간·주간 계정, Claude Pro·Team 요금제 표기 (받은 화면을 fixture로 추가). 해당 계정이 없어 1.1.0에서도 미확인으로 남긴다
- [x] helper 연결 진단 (0.6.3·helper v0.6.3에 포함. 설치된 helper로 상태별 문구를 직접 확인하는 일은 남음): 팝업에서 "설치 안 됨 / 이 확장 ID가 허용 목록에 없음 / 실행 실패"를 구분해 보여 주고, `leeway-helper.exe`를 실행하면 레지스트리·manifest·허용 ID를 스스로 점검해 출력. 비슷한 구조의 제품들에서 가장 많은 문의가 "설치했는데 연결 안 됨"이다
- [x] 제품 사이트(영어·한국어, FAQ·구조화 데이터), `llms.txt`·`sitemap.xml`, README 첫 화면, Google Search Console·Bing 등록 (2026-10-27)
- [ ] helper 배포 보강: GitHub Releases(sha256 포함)는 유지하고 winget에 등록, SignPath Foundation 무료 서명 신청 (Azure Artifact Signing은 개인이면 미국·캐나다만 가능)
- [ ] 후원 링크 (2026-10-30 결정, `feat/sponsor-links`): `.github/FUNDING.yml`(GitHub Sponsors + Buy Me a Coffee), 팝업 맨 아래
      dim 텍스트 링크 1개(아이콘·배지·애니메이션 없음), `support_leeway` 6개 언어, README·제품 페이지 두 개·`docs/llms.txt`.
      수수료·추적·서드파티 요청이 없어 `PRIVACY.md`와 스토어 개인정보 탭은 그대로다. §5 검증은 통과했다.
      **머지 조건**: GitHub Sponsors 활성화와 Buy Me a Coffee 핸들 확보가 먼저다 — 계정이 없으면 사이트·저장소에 공개되는 링크가 404가 된다.
      한국 계좌 지급이 실제로 되는지는 미확인(가입 시 Payout 화면에서 확인). 팝업 링크는 1.1.0 심사가 끝난 뒤 다음 버전에 실린다(CLAUDE.md §6).
      팝업의 실제 모양은 미확인(`test_popup.mjs`는 레이아웃·CSS를 보지 않는다). 6개 언어 새 문구는 원어민 검토 전
- [ ] 알릴 곳: r/ClaudeAI(도구 소개 글은 메가스레드로 안내될 수 있음), Product Hunt. 차별점은 "Windows에서 쓰는 확장, 쿠키·토큰을 붙여넣거나 저장하지 않음". 링크는 `scripts/make_link.py`로 만들고, 장소 목록에 없는 곳(예: Product Hunt)은 스크립트 `SOURCES`와 `docs/tracking-links.md`에 먼저 추가한다

지표 (분석 도구 없이 볼 수 있는 것):
- 스토어 개발자 대시보드의 설치·주간 사용자·제거 수
- GitHub Releases의 `leeway-helper.exe` 다운로드 수 ÷ 스토어 사용자 수 → helper 기능 수요의 대략적 비율

2단계로 넘어갈 신호: 사용자 수가 의미 있게 늘고(목표치는 그때 정한다), helper 다운로드나 다중 계정·오버레이 관련 요청이 실제로 들어올 때.

---

## 2단계 — helper를 Leeway Desktop으로

목표: 확장으로는 못 하는 것을 helper가 맡는다. 확장만 쓰는 사용자의 경험은 그대로 둔다.

첫 기능: **테두리 없는 데스크톱 오버레이**
- 크기·위치 고정, 항상 위, 탭과 무관(PiP의 주소 표시줄·크기 조절·열었던 탭에 묶이는 문제 해결)
- 펼침/접힘 디자인은 지금 오버레이(A/B)를 그대로 따른다

구조 변화:
- 팝업의 "실험 기능 → 다른 Chrome 프로필"을 **"Leeway Desktop 연결"** 하나로 바꾼다. 연결되면 확장이 항상 값을 helper로 보낸다.
- helper는 지금의 Native Messaging 호스트(메시지마다 실행)와 **계속 떠 있는 오버레이 앱**, 두 모드가 된다. 둘은 `profiles.json`으로 연결한다.
- 확장과 helper의 데이터 형식 버전을 맞추는 핸드셰이크를 둔다(구버전 helper는 안내 문구로).
- 설치 권유는 그 기능을 쓰려는 순간에만 띄운다(예: 오버레이에서 "항상 위 고정"을 누를 때). 상시 배너는 두지 않는다.
- helper가 없거나 꺼져 있어도 확장은 지금처럼 PiP 오버레이로 동작하고, 무엇이 빠졌는지만 한 줄로 알린다.

결정할 것:
- 화면 기술: **Tauri**(HTML/CSS 재사용) vs **Go + WebView2**(지금 helper와 같은 언어). 작은 시제품으로 비교
- 자동 실행·트레이 아이콘·위치 기억·클릭 통과 모드 중 첫 버전에 넣을 것

넣지 않을 것: Claude Code의 OAuth 토큰을 읽어 사용량을 가져오는 기능 (Anthropic 정책상 외부 앱 사용 불가).

---

## 3단계 — 배포와 수익화 검토

- Microsoft Store(MSIX) 배포: Store가 무료로 서명해 SmartScreen 경고가 사라진다. 다만 MSIX 앱은 레지스트리·파일 쓰기가 가상화·샌드박스되어, Claude Desktop과 Codex Desktop도 Windows에서 Native Messaging 연결 문제를 겪었다. 작은 MSIX 시제품으로 Chrome이 호스트를 찾고 대화하는지 먼저 확인한다
- Store에 EXE/MSI로 올리는 길은 신뢰된 인증서로 서명된 파일이 필요하다 → SignPath 서명이 먼저 있어야 한다
- 유료 서명이 필요해지면 OV 인증서(연 $150–300, 하드웨어 토큰 필요). EV도 2024년부터 SmartScreen을 바로 통과하지 못한다
- Desktop 유료 여부와 가격: 이때 정한다. 확장은 계속 무료
- 유료화 경로: Chrome Web Store 자체 결제가 폐지된 뒤로는 ExtensionPay(Stripe 기반)가 사실상 표준이다.
  자체 서버 없이 라이선스 검증이 되는지는 미확인 — Desktop 유료화를 정할 때 함께 확인한다

### 광고는 붙이지 않는다 (2026-10-30 결정)

확장 안에 광고를 넣는 안을 조사하고 접었다. 정책과 규모 양쪽에서 막히고, 막히지 않는 구성은 수익이 사실상 없다.
근거는 아래 [근거](#근거)의 "광고·수익모델 조사"에 있다. 대신 **후원**(1단계)과 **Desktop 유료화**(이 단계)로 간다.

절대 하지 않을 것:

- 확장 내 AdSense·Ad Manager·AdMob 태그 (정책상 금지)
- claude.ai·chatgpt.com·gemini.google.com 페이지로의 광고 주입, 그 페이지에 겹치는 광고 (single purpose 위반)
- 사용량 데이터를 광고 타게팅·판매·개인화에 쓰는 것 (동의를 받아도, 익명화해도 금지)
- 공시·개인정보처리방침을 고치기 전에 광고나 식별자 코드를 먼저 배포하는 것
- 조용한 추천·제휴 링크 (공시 없는 어필리에이트는 문서화된 삭제 사유다)
- PiP 오버레이·툴바 배지 같은 상시 노출 면에 광고를 두는 것 (정책 문언이 없는 미확인 영역이라 보수적으로 피한다)

광고를 시험해 보고 싶다면 CWS 정책 밖인 **제품 사이트**(`docs/`)가 유일하게 리스크 없는 면이다.
다만 Carbon Ads 기준 월 1만 PV가 가입 문턱이라 지금은 신청 자체가 안 된다 — 선행 과제는 광고 코드가 아니라 트래픽이다.

---

## 근거

- 별도 helper가 선택 기능이면 핵심 사용감 피해는 작고, 주된 위험은 "설치했는데 연결 안 됨" 리뷰가 확장 평점으로 돌아오는 것 — 2026-10-27 리서치 보고서 "확장 helper 설치 사용자 반응"
- 다중 계정 수요는 Claude Code 사용자·프리랜서·구독을 여러 개 쓰는 사람에게 몰려 있고, 이들이 exe 설치를 감수하는 층과 겹친다 — 같은 보고서

### 광고·수익모델 조사 (2026-10-30)

1차 출처 21건을 적대적 3표 검증한 결과(105개 주장 중 17개 통과, 8개 반박). 정책 결론은 신뢰도 높음, 금액·네트워크 약관은 일부 2차 출처.

- 확장 내부 AdSense는 금지다. CWS Ads 정책 3항이 "Currently, AdSense may not be used to serve ads in Products"이고,
  상류의 AdSense 배치 정책은 "toolbars, browser extensions, and desktop applications"를 직접 호명한다.
  자체 호스팅 페이지를 iframe으로 띄우는 우회도 같은 조항("소프트웨어 애플리케이션을 통한 배포")에 걸린다
- 서드파티 광고 JS는 기술적으로도 못 싣는다. MV3가 `extension_pages`의 `script-src`를 `self`·`none`·`wasm-unsafe-eval`로 고정하고
  (Chromium `csp_validator.cc`), 광고 도메인 allowlist는 매니페스트 단계에서 거부된다. Google 자체 태그도 거절된 사례가 있다
- 페이지 주입은 single purpose 위반이다. Google 공식 FAQ가 "Can I bundle ad injection with some other type of functionality?"에 "No"로
  직답하고, 구제책은 "광고를 멈추거나 광고 외 전 기능을 제거"하는 양자택일뿐이다
- 사용량 데이터의 광고 활용은 Limited Use로 전면 금지다. 동의 예외도 익명화 방어도 없다(2026-08-01 시행 강화판이 현행)
- "no server, no analytics" 공개 약속을 뒤집으면 대시보드 공시·개인정보처리방침·UI 내 공시·기존 사용자 선제 고지가 모두 필요하고,
  세 곳과 실제 동작이 어긋나면 퍼블리셔 계정 전체 정지와 기존 설치 기반 비활성화까지 갈 수 있다
- **규모가 더 결정적인 벽이다.** EthicalAds는 월 5만 PV·CPM 약 $2.50, Carbon Ads는 사이트 월 1만 PV·typical CPM $1.50–2.30을 요구하고
  둘 다 "자기 네트워크 광고만" 조건이다. Carbon은 CLI·TUI·AI 어시스턴트 지면을 받지만 브라우저 확장은 언급 자체가 없다.
  지금 설치 규모에서는 가입 문턱을 넘지 못하고, 넘어도 월 20달러 미만이다. 사용자 7만 명대 확장이 광고 단독으로 거의 벌지 못한 보고도 있다
- 어필리에이트도 성립하지 않는다. Anthropic·OpenAI에 개인 대상 공개 제휴 프로그램이 없다(Anthropic은 엔터프라이즈 Partner Network,
  OpenAI는 캠페인성 추천만). 2차 출처 기준이라 미확정
- 확장 **자체 팝업** 안의 비AdSense contextual 광고는 금지 조항도, 2025~2026년 승인 선례도 확인되지 않은 회색 지대다
- 반박된 주장(쓰지 말 것): "2026 정책 업데이트에 AI 서비스의 usage limit 우회를 겨냥한 확장 금지 조항이 추가됐다"는 0-3으로 반박됐다.
  그런 조항은 확인되지 않았으므로 Leeway의 리스크로 적지 않는다

출처: [CWS Ads 정책](https://developer.chrome.com/docs/webstore/program-policies/ads) · [CWS Program Policies](https://developer.chrome.com/docs/webstore/program-policies/policies) · [AdSense 배치 정책](https://support.google.com/adsense/answer/1346295) · [MV3 remote code](https://developer.chrome.com/docs/extensions/develop/migrate/improve-security) · [MV3 CSP](https://developer.chrome.com/docs/extensions/reference/manifest/content-security-policy) · [Single purpose FAQ](https://developer.chrome.com/docs/extensions/mv3/single_purpose/) · [Limited Use](https://developer.chrome.com/docs/webstore/program-policies/limited-use) · [User Data FAQ](https://developer.chrome.com/docs/webstore/program-policies/user-data-faq) · [2026 정책 업데이트](https://developer.chrome.com/blog/cws-policy-updates-2026) · [어필리에이트 정책 2025](https://developer.chrome.com/blog/cws-policy-update-affiliate-ads-2025) · [EthicalAds Publisher FAQ](https://www.ethicalads.io/publishers/faq/) · [Carbon Ads Join](https://www.carbonads.net/join) · [Carbon Ads for CLI](https://carbonads.net/cli) · [ExtensionPay](https://extensionpay.com/articles/extensionpay-is-the-chrome-web-store-payments-replacement)

### 비슷한 구조의 제품 (2026-10-27 조사)

| 제품 | 앱 없이 | 앱이 더하는 것 | 권유 방식 | 앱 배포 |
|---|---|---|---|---|
| Bitwarden | 확장 전부 동작 | 생체 인증 잠금 해제 | 설정 토글 + 권한 승인, 앱 쪽도 켜야 함 | 데스크톱 앱 |
| 1Password | 문서에 명시 없음 | 확장이 앱과 함께 잠기고 풀림 | 확장·앱 양쪽 설정 토글 | 데스크톱 앱 |
| Zotero | zotero.org에 저장 가능 | 로컬 저장, Google Docs 인용 | "Zotero가 실행 중인가요?" 안내 | 데스크톱 앱 |
| Video DownloadHelper | 문서에 명시 없음 | 파일 쓰기, ffmpeg 변환 | 확장이 CoApp 설치를 안내 | GitHub Releases 설치 파일 (CoApp) |
| Grammarly | 웹사이트에서 동작 | 웹 밖의 앱(Word, 메일)에서도 동작 | 별도 다운로드 페이지 | 설치 파일 |

AI 사용량 도구:
- 확장: Claude Usage Tracker(lugia19) Chrome 약 20만 명·Firefox 약 4.7천 명. Firebase로 기기 간 동기화(서버 사용)
- 데스크톱 앱은 macOS 메뉴바가 대부분(CodexBar, ClaudeUsageBar, Usage4Claude), 배포는 GitHub Releases·Homebrew. ClaudeUsageBar는 Product Hunt 일간 1위(398표)
- Windows 앱: Win-CodexBar(GitHub Releases + winget, 아직 서명 없음, SignPath 준비 중), Claude Usage Tray(winget)
- 이 앱들은 Claude 세션 쿠키를 붙여넣게 하거나 Claude Code의 OAuth 토큰을 읽는다. Leeway는 이 방식을 쓰지 않는다(CLAUDE.md §3)

출처: [Bitwarden 생체 인증](https://bitwarden.com/learning/unlock-your-vault-with-biometrics) · [1Password 확장 연결](https://support.1password.com/connect-1password-browser-app/) · [Zotero Connector](https://zotero.org/support/kb/connector_zotero_unavailable) · [VDH CoApp](https://www.downloadhelper.net/install-coapp) · [Grammarly 데스크톱](https://www.grammarly.com/desktop) · [Claude Usage Tracker (Chrome)](https://chromewebstore.google.com/detail/claude-usage-tracker/knemcdpkggnbhpoaaagmjiigenifejfo) · [CodexBar](https://project-awesome.org/r/steipete-CodexBar) · [Win-CodexBar](https://github.com/nesszer/Win-CodexBar) · [Claude Usage Tray](https://wingetly.io/apps/mlcousek/claude-usage-tray) · [ClaudeUsageBar](https://www.producthunt.com/products/claudeusagebar) · [Windows 코드 서명 선택지](https://learn.microsoft.com/en-us/windows/apps/package-and-deploy/code-signing-options) · [Claude Desktop MSIX Native Messaging 이슈](https://github.com/anthropics/claude-code/issues/58009) · [Codex Desktop 레지스트리 이슈](https://github.com/openai/codex/issues/24040)
