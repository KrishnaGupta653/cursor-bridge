# Cursor Remote 사용자 매뉴얼

**모바일에서 Cursor IDE를 원격 제어하기 위한 완벽 가이드**

---

## 목차

1. [개요](#1-개요)
2. [사전 요구사항](#2-사전-요구사항)
3. [연결 방식 비교](#3-연결-방식-비교)
4. [Cursor Extension 설치](#4-cursor-extension-설치)
5. [로컬 서버 연결 방법](#5-로컬-서버-연결-방법)
6. [릴레이 서버 연결 방법](#6-릴레이-서버-연결-방법)
7. [모바일 앱 설정](#7-모바일-앱-설정)
8. [Cursor 2.4 기능](#8-cursor-24-기능)
9. [문제 해결](#9-문제-해결)

---

## 1. 개요

### Cursor Remote란?

Cursor Remote는 모바일 기기에서 PC의 Cursor IDE를 원격으로 제어할 수 있는 시스템입니다.

**주요 기능:**
- 📱 Cursor **Agents 창**의 채팅 목록·실시간 응답·변경 파일을 휴대폰에서 확인
- 📝 특정 채팅에 프롬프트 전송, 모델·모드 변경, 에이전트 중지
- ✅ 화면에 표시된 바로 그 요청만 승인·거절 (확인 탭 필요, 감사 로그 기록)
- 🌍 릴레이 모드로 어디서든 연결 (같은 네트워크 불필요)
- 🔐 5분짜리 일회용 페어링 코드, 24시간 릴레이 세션

### 시스템 구성

```
┌─────────────┐                    ┌─────────────┐                    ┌─────────────┐
│   Mobile    │◄───────────────────►│   Server    │◄───────────────────►│  Cursor IDE │
│     App     │     WebSocket       │  (Local or  │     Extension API   │  Extension  │
└─────────────┘                     │   Relay)    │                     └─────────────┘
                                    └─────────────┘
```

---

## 2. 사전 요구사항

### PC 환경

| 항목 | 요구사항 |
|------|---------|
| OS | Windows, macOS, Linux |
| Cursor IDE | 최신 버전 설치 |
| Cursor CLI | 설치 및 인증 필요 (CLI 모드 사용 시) |
| Node.js | v18 이상 권장 |
| npm | Node.js와 함께 설치됨 |

### Cursor CLI 설치 및 인증

CLI 모드를 사용하려면 Cursor CLI를 설치하고 인증해야 합니다.

#### CLI 설치

```bash
curl https://cursor.com/install -fsS | bash
```

이 명령어는 Cursor CLI를 `~/.local/bin/` 디렉토리에 설치합니다.

#### PATH 설정

**Zsh 사용자 (macOS 기본):**
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc
```

**Bash 사용자:**
```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

#### 설치 확인

```bash
which agent
# 또는
agent --version
```

#### 인증 (필수)

```bash
agent login
```

브라우저가 열리며 Cursor 계정으로 로그인합니다. 인증은 저장되므로 한 번만 로그인하면 됩니다.

#### 인증 상태 확인

```bash
agent status
```

인증되면 다음과 같이 표시됩니다:
```
✅ Authenticated as: your-email@example.com
```

#### CLI 테스트

```bash
agent -p --output-format json --force 'Hello, world!'
```

JSON 응답이 출력되면 CLI 설정이 완료된 것입니다.

### 모바일 환경

| 항목 | 요구사항 |
|------|---------|
| Android | 5.0 이상 |
| iOS | 12.0 이상 |
| 네트워크 | Wi-Fi 또는 모바일 데이터 |

### 네트워크 요구사항

| 연결 방식 | 네트워크 조건 |
|-----------|--------------|
| 로컬 서버 | PC와 모바일이 **같은 Wi-Fi** 네트워크에 연결 |
| 릴레이 서버 | 인터넷 연결만 있으면 됨 (네트워크 무관) |

---

## 3. 연결 방식 비교

Cursor Remote는 두 가지 연결 방식을 지원합니다.

### 로컬 서버 vs 릴레이 서버

| 특성 | 로컬 서버 | 릴레이 서버 |
|------|----------|------------|
| **네트워크** | 같은 Wi-Fi 필수 | 어디서나 연결 가능 |
| **응답 속도** | ⚡ 매우 빠름 | 🔄 약간의 지연 |
| **설정 난이도** | 쉬움 | 약간 복잡 |
| **보안** | 로컬 네트워크 내 | 인터넷 통신 (암호화됨) |
| **서버 관리** | PC에서 직접 실행 | Vercel 클라우드 사용 |
| **외부 접속** | ❌ 불가 | ✅ 가능 |

### 언제 어떤 방식을 선택할까?

**로컬 서버 권장:**
- 집이나 사무실에서 같은 Wi-Fi 사용 시
- 빠른 응답 속도가 중요할 때
- 간단한 설정을 원할 때

**릴레이 서버 권장:**
- 외부에서 PC에 접속해야 할 때
- 모바일 데이터를 사용할 때
- 네트워크 환경이 다를 때

---

## 4. Cursor Extension 설치

> ⚠️ **중요**: 로컬 서버든 릴레이 서버든, Extension 설치는 **반드시 필요**합니다.

### Step 1: 소스 코드 다운로드

```bash
# 프로젝트 클론
git clone https://github.com/your-repo/cursor-remote.git
cd cursor-remote
```

### Step 2: Extension 컴파일

```bash
cd cursor-extension
npm install
npm run compile
```

### Step 3: Cursor IDE에 Extension 로드

**방법 A: 개발자 모드로 로드 (권장)**

1. Cursor IDE 실행
2. `Cmd+Shift+P` (Mac) / `Ctrl+Shift+P` (Windows/Linux)
3. "Developer: Install Extension from Location..." 검색 및 선택
4. `cursor-extension` 폴더 선택

**방법 B: F5로 개발 호스트 실행**

1. VS Code/Cursor에서 `cursor-extension` 폴더 열기
2. `F5` 키를 눌러 Extension Development Host 실행
3. 새 창이 열리면서 Extension 활성화

### Step 4: Extension 활성화 확인

Extension이 정상적으로 활성화되면 상태 표시줄 우측 하단에 다음이 표시됩니다:

| 상태 | 의미 |
|------|------|
| 📡 **Remote :8766** | 서버 실행 중 (포트 표시), 연결된 기기 없음. `●` 표시는 이 창에서 Telegram 봇 실행 중 |
| 📡 **Remote · 1 device** | 기기 연결됨 (릴레이 연결 시 `relay <세션 ID>` 표시) |
| 🚫 **Remote off** | 서버 중지됨 |

상태 표시줄 항목을 클릭하면 기기 페어링, Telegram, 터널, 로그 등 모든 작업 메뉴가 열립니다.

**상태 표시줄이 안 보인다면:**
- 명령 팔레트 (`Cmd+Shift+P`)에서 "Cursor Remote: Start Server" 실행

### Cursor IDE 설정

#### 설정 열기

**가장 빠른 방법:**
- `Cmd + ,` (Mac) / `Ctrl + ,` (Windows/Linux)

**또는 메뉴에서:**
- 상단 메뉴바 → Cursor → Settings → Settings

**또는 명령 팔레트:**
- `Cmd+Shift+P` → "Preferences: Open Settings"

#### Cursor Remote 설정 찾기

설정이 열리면 검색창에 `Cursor Remote` 또는 `cursorRemote`를 입력하세요.

**주요 설정 항목:**
- **Cursor Remote: Enable Cdp** (`cursorRemote.enableCdp`) - 세션 제어 허용 (Agents 창 제어에 필요)
- **Cursor Remote: Remote Actions** (`cursorRemote.remoteActions`) - `disabled`이면 휴대폰·텔레그램의 채팅 열기/새 채팅, 모델·모드 변경, 중지, 승인·거절을 모두 끔
- **Cursor Remote: Relay Server Url** (`cursorRemote.relayServerUrl`) - 직접 배포한 릴레이를 쓸 때만 설정
- **Cursor Remote: Allowed Web Socket Origins** - 로컬 모드에서 허용할 브라우저 출처

#### 세션 제어 켜기 (필수)

Extension은 `127.0.0.1:9222`의 Chrome DevTools Protocol로 Cursor Agents 창을 제어합니다. 이 포트는
네트워크에 노출되지 않습니다.

1. 설정에서 **Cursor Remote: Enable Cdp**를 켭니다:

   ```json
   {
     "cursorRemote.enableCdp": true
   }
   ```

2. `Cmd+Shift+P` → **Cursor Remote: Restart Cursor with Session Control**. 저장하지 않은 파일을 확인한
   뒤 Cursor가 종료되고 세션 제어가 켜진 상태로 다시 열립니다.

세션 제어가 꺼져 있으면 휴대폰에서 채팅은 읽을 수 있지만 전송·중지·승인은 할 수 없습니다. Cursor를
일반적으로 열었다면 Extension이 재시작을 한 번 제안합니다.

---

## 5. 로컬 서버 연결 방법

### 아키텍처

```
휴대폰 / 웹 앱  ⇄  WebSocket ws://<Mac IP>:8766  ⇄  Cursor Extension  ⇄  CDP 127.0.0.1:9222  ⇄  Agents 창

※ 기본 포트는 8766, Cursor 창이 여러 개면 8767~8776 사용
※ PC와 모바일이 같은 Wi-Fi 네트워크에 있어야 합니다
```

### Step 1: Extension 실행 확인

1. Cursor IDE 실행
2. 상태 표시줄에서 "Remote :8766" 또는 "Remote · 1 device" 확인
3. 안 보이면: `Cmd+Shift+P` → "Cursor Remote: Start Server"

### Step 2: 기기 페어링

1. 상태 표시줄 클릭 → **Pair a device** (또는 `Cmd+Shift+P` → **Cursor Remote: Pair Client**)
2. 일회용 코드가 클립보드에 복사되고, 입력할 주소와 포트가 함께 표시됩니다
3. 코드는 **한 번만** 쓸 수 있고 **5분** 후 만료됩니다

### Step 3: 모바일 앱 연결

1. 앱에서 **Local** 선택
2. **Mac address**: Cursor가 실행 중인 Mac의 IP (예: `192.168.0.10`, macOS에서는 `ipconfig getifaddr en0`)
3. **Port**: Extension 실제 포트 (기본 `8766`)
4. **Connect** → 페어링 코드 붙여넣기

페어링된 기기는 24시간 동안 코드 없이 다시 연결됩니다. **Cursor Remote: Revoke All Paired Clients**로
모든 기기를 로그아웃시킬 수 있습니다.

> 📝 브라우저에서 접속할 때는 웹 앱 출처가 `cursorRemote.allowedWebSocketOrigins`에 있어야 합니다
> (Pair Client가 현재 출처 추가를 제안합니다). `https://` 웹 앱은 로컬 `ws://` 연결을 열 수 없으므로
> 릴레이를 사용하세요.

### Step 4: 연결 확인

- 모바일 앱: Agents 사이드바(채팅 목록) 표시
- Cursor 상태 표시줄: "Remote · 1 device"
- Output 패널: `Client connected` 로그

### 포트 정보

| 포트 | 프로토콜 | 용도 |
|------|----------|------|
| 8766 | WebSocket | 모바일 앱 ↔ Extension (기본 포트, Cursor 창이 여러 개면 8767~8776) |
| 9222 | CDP (127.0.0.1 전용) | Extension ↔ Cursor 창 |

---

## 6. 릴레이 서버 연결 방법

### 아키텍처

```
휴대폰 / 웹 앱  ⇄  HTTPS 폴링  ⇄  Vercel 릴레이 (Upstash Redis)  ⇄  HTTPS 폴링  ⇄  Cursor Extension

※ PC와 모바일이 다른 네트워크에 있어도 연결 가능
※ 기본 릴레이: https://cursor-remote-rela.vercel.app
```

### Step 1: Mac에서 세션 연결

1. 상태 표시줄 클릭 → **Connect to relay…** (또는 `Cmd+Shift+P` → **Cursor Remote: Connect to Relay by Session ID**)
2. 6자리 영숫자 세션 ID 입력 (예: `ABC123`). Enter만 누르면 마지막 세션 ID를 재사용합니다
3. 연결되면 "connected to relay session" 알림이 표시됩니다

### Step 2: 휴대폰 페어링

1. `Cmd+Shift+P` → **Cursor Remote: Pair Relay Client**
2. 페어링 코드가 복사되고 세션 ID와 함께 표시됩니다. 코드는 **한 번만** 쓸 수 있고 **5분** 후 만료됩니다
3. 앱에서 **Relay** 선택 → 세션 ID 입력 → 페어링 코드 붙여넣기

### 로그인 유지와 로그아웃

- 앱은 세션이 끝날 때까지 로그인을 기기에 저장합니다(웹은 브라우저 localStorage). 페이지를 새로 고치거나
  앱을 다시 시작해도 "Connecting…" 후 코드 없이 다시 연결됩니다
- **Log out**: Agents 사이드바 맨 아래, 상단 로그아웃 버튼 또는 설정. 확인 후 릴레이에서 이 휴대폰의 로그인을
  폐기하고 저장된 로그인을 지웁니다. 릴레이에 연결할 수 없어도 휴대폰에서는 지워지며, 릴레이의 로그인은
  세션이 끝날 때 만료됩니다
- 세션이 끝나면(24시간, **Start New Relay Session**, **Revoke Relay Session**) 앱이 "This relay session ended…"
  라고 알려 주고 새 페어링 코드를 요청합니다. 네트워크 오류나 Mac 미연결(409)일 때는 로그인을 유지하고 다시 시도합니다
- 공용 기기에서는 사용 후 반드시 로그아웃하세요. 저장된 로그인은 이 앱(웹은 같은 사이트)과 기기에 접근할 수
  있는 사람이 읽을 수 있습니다

### 재사용 페어링 코드 (선택)

설정 `cursorRemote.reusablePairingCode`를 켜면 세션 전체에 페어링 코드 하나를 씁니다.

- 최대 **3대**까지 페어링할 수 있고, 세션이 끝나면 만료됩니다. Pair Relay Client를 다시 실행하면 같은 코드와
  남은 횟수·유효 시간을 보여 줍니다
- **위험**: 코드를 본 사람은 세션이 끝나거나 새 세션을 시작할 때까지 접속할 수 있습니다. 코드를 공유하지 마세요
- 기기가 참여할 때마다 "A new device joined relay session …" 알림이 뜹니다. 모르는 기기라면 알림의
  **Start New Relay Session**을 눌러 모든 기기와 코드를 폐기하세요
- 3번 다 쓰면 앱에 "This pairing code was used on 3 devices…"가 표시되고, Pair Relay Client가 새 코드를 만듭니다
- 설정을 꺼도 이미 보여 준 코드는 취소되지 않습니다. 취소하려면 **Start New Relay Session**을 실행하세요
- 릴레이가 재사용 코드를 지원하지 않으면 일회용 코드가 나옵니다

### 세션 규칙

| 항목 | 동작 |
|------|------|
| 세션 유효기간 | **24시간**. 이후 또는 이미 사용된 ID이면 Extension이 새 무작위 ID로 바꾸고, 휴대폰을 다시 페어링합니다. 한 번 쓴 ID는 다시 쓸 수 없습니다. |
| 페어링 코드 | 일회용, 5분 후 만료 (재사용 코드를 켜면 세션 동안 최대 3대). 접속에 실패해도 코드는 소모되지 않습니다 |
| 자격 증명 | 256비트 capability 토큰, 릴레이에는 해시만 저장 |
| 메시지 | 5분 후 만료, 응답은 요청한 휴대폰에만 전달 |
| Mac 연결 상태 | Extension이 폴링할 때마다 갱신 (휴대폰 사용 중 2초, 유휴 시 25초 간격). 2분 넘게 폴링이 없으면 휴대폰이 새로 참여할 수 없습니다 |
| 휴대폰 | 약 2분간 폴링하지 않은 휴대폰은 세션에서 제외됩니다 |
| Cursor 재시작 | 한 창이 마지막 세션에 자동으로 다시 연결됩니다. 다른 창에서 릴레이 명령을 실행하면 이미 다른 창이 연결되어 있다고 알려줍니다 |

### 명령어

| 명령어 | 설명 |
|--------|------|
| `Cursor Remote: Connect to Relay by Session ID` | 이 Mac을 릴레이 세션에 연결 |
| `Cursor Remote: Pair Relay Client` | 휴대폰용 페어링 코드 (일회용, 또는 설정 시 세션의 재사용 코드) |
| `Cursor Remote: Start New Relay Session` | 현재 세션을 폐기하고 새 세션 시작 (휴대폰 다시 페어링) |
| `Cursor Remote: Revoke Relay Session` | 현재 세션 폐기 |
| `Cursor Remote: Set Relay Session ID` | 저장된 세션 ID 변경 |

### Mac 깨어 있게 하기

Mac이 깨어 있고 온라인일 때만 휴대폰이 Cursor에 접근할 수 있습니다. 자리를 비울 때는 터미널에서 다음을
실행하세요 (Ctrl+C로 종료):

```bash
caffeinate -dimsu
```

### 직접 릴레이 배포하기 (선택)

기본 릴레이 대신 직접 배포하려면 [relay-server/README.md](./relay-server/README.md)를 따르세요
(Upstash Redis + Vercel, 환경변수 `UPSTASH_REDIS_REST_URL`, `UPSTASH_REDIS_REST_TOKEN`). 그 다음 Cursor
설정의 `cursorRemote.relayServerUrl`과 앱의 릴레이 URL을 바꿉니다.

---

## 7. 모바일 앱 설정

### 앱 빌드 및 설치

```bash
cd mobile-app
flutter pub get
flutter build apk        # Android
flutter build ios        # iOS
```

### 앱 연결 화면

| 항목 | Local | Relay |
|------|-------|-------|
| 입력 | Mac IP + 포트 (기본 8766) | 세션 ID (6자리) |
| 페어링 | **Pair Client** 코드 | **Pair Relay Client** 코드 |
| 웹 앱 (https) | 사용 불가 | 사용 가능 |

### 기본 사용법

1. **채팅 선택**: Agents 사이드바에서 채팅을 엽니다. 새 응답은 실시간으로 표시됩니다
2. **프롬프트 전송**: 입력창에 입력 후 전송. Mac의 입력창에 작성 중인 내용이 있으면 덮어쓰지 않고 거절됩니다
3. **모델·모드 변경, 중지**: 채팅 화면 상단/입력창의 메뉴 사용
4. **승인·거절**: 에이전트가 요청을 기다리면 카드가 표시됩니다. 확인 단계를 거친 뒤 그 요청에만 적용됩니다
5. 모든 원격 작업은 Cursor의 **Cursor Remote** 출력에 `[Audit]` 줄로 기록됩니다

---

## 8. Cursor 2.4 기능

Cursor Remote는 Cursor 2.4의 새로운 기능들과 완전 호환됩니다.

### 호환성 확인 완료

| 기능 | 상태 | 비고 |
|------|------|------|
| **Subagents** | ✅ 자동 지원 | CLI가 자동으로 서브에이전트 사용 |
| **Skills (SKILL.md)** | ✅ 자동 지원 | 워크스페이스에 SKILL.md 있으면 자동 적용 |
| **Clarification Questions** | ✅ 지원 | 에이전트 질문 → 모바일 답변 → 세션 유지 |
| **Image Generation** | ⚠️ 부분 지원 | 생성 결과는 `assets/`에 저장됨 |

### Subagents (서브에이전트)

Cursor 2.4의 서브에이전트는 **자동으로 동작**합니다. 별도 설정 없이 모바일에서 프롬프트를 전송하면 CLI가 필요에 따라 서브에이전트를 활용합니다.

**특징:**
- 코드베이스 조사, 터미널 작업 등을 병렬로 처리
- 응답 품질 향상
- 추가 설정 불필요

### Skills (SKILL.md)

워크스페이스에 `SKILL.md` 파일을 추가하면 커스텀 명령이나 절차를 정의할 수 있습니다.

**사용 방법:**
1. 프로젝트 루트 또는 `.cursor/` 폴더에 `SKILL.md` 생성
2. 커스텀 명령, 스크립트, 절차 정의
3. 모바일에서 프롬프트 전송 시 자동 적용

**예시 (SKILL.md):**
```markdown
# 프로젝트 빌드 스킬

## build
프로젝트를 빌드합니다:
1. npm install 실행
2. npm run build 실행
3. 빌드 결과 확인
```

### Clarification Questions (에이전트 질문)

에이전트가 작업 중 추가 정보가 필요할 때 질문을 던질 수 있습니다. Cursor Remote에서는 이 흐름이 완전히 지원됩니다.

**동작 방식:**
1. 모바일에서 프롬프트 전송
2. 에이전트가 질문 응답 (예: "어떤 기능을 추가할까요?")
3. 모바일에서 답변 입력
4. **같은 세션**에서 대화 계속 (`--resume` 자동 사용)

**기술 세부사항:**
- 에이전트 질문은 `assistant` 타입 메시지로 전달
- `session_id`가 유지되어 대화 컨텍스트 보존
- Extension이 자동으로 세션 관리

### Image Generation (이미지 생성)

> ⚠️ CLI에서 이미지 생성 지원 여부는 Cursor 버전에 따라 다를 수 있습니다.

에이전트가 이미지를 생성하면 기본적으로 `assets/` 폴더에 저장됩니다.

**참고:**
- 이미지 생성 요청 시 응답에 파일 경로 포함
- 생성된 이미지는 PC의 워크스페이스에서 확인 가능

### CLI 옵션 참고

Cursor Remote Extension이 사용하는 CLI 옵션:

```bash
cursor agent -p \
  --resume <session_id> \      # 세션 재개
  --mode <plan|ask> \          # 모드 선택
  --output-format stream-json \
  --stream-partial-output \
  --force \
  "<prompt>"
```

| 옵션 | 설명 |
|------|------|
| `-p` | 비대화형 모드 (스크립트용) |
| `--resume` | 이전 세션 재개 |
| `--mode` | plan(계획), ask(질문) 모드 |
| `--output-format` | 출력 형식 (stream-json) |
| `--force` | 명령 자동 승인 |

---

## 9. 문제 해결

### 에러 메시지 빠른 참조

| 에러 메시지 | 원인 | 해결 방법 |
|------------|------|----------|
| `EADDRINUSE` | 포트가 이미 사용 중 | [포트 충돌 해결](#포트-충돌-eaddrinuse) |
| `EPERM: operation not permitted` | 네트워크 권한 문제 | [권한 문제 해결](#포트-권한-문제-eperm) |
| `Cursor CLI (agent)가 설치되어 있지 않습니다` | CLI 미설치 | [CLI 설치](#cli-미설치) |
| `Failed to connect to relay` | 릴레이 서버 연결 실패 | [릴레이 연결 문제](#릴레이-서버-연결-실패) |
| `Session not found` / `세션이 만료됨` | 세션 만료 또는 없음 | [세션 문제](#세션-만료-또는-없음) |
| `No active editor` | 편집기 열려 있지 않음 | Cursor에서 파일 열기 |
| `WebSocket connection failed` | WebSocket 연결 실패 | [WebSocket 문제](#websocket-연결-실패) |

---

### Extension 관련

#### Extension이 활성화되지 않는 경우

**증상:** 상태 표시줄에 Cursor Remote가 표시되지 않음

**해결:**
```bash
# 다시 컴파일
cd cursor-extension
npm install
npm run compile
```

1. Cursor IDE 재시작
2. 명령 팔레트에서 "Developer: Reload Window" 실행
3. 그래도 안 되면: `Cmd+Shift+P` → "Cursor Remote: Start Server"

#### 상태 표시줄이 보이지 않는 경우

1. `Cmd+Shift+P` → "Cursor Remote: Start Server" 실행
2. Output 패널 확인: `View` → `Output` → "Cursor Remote" 선택
3. 에러 메시지가 있으면 해당 섹션 참조

---

### 포트 관련

#### 포트 충돌 (EADDRINUSE)

**증상:**
```
Error: listen EADDRINUSE: address already in use :::8766
포트 8766이 사용 중입니다
```

**해결:**
```bash
# 1. 포트 사용 확인
lsof -i :8766

# 2. 해당 프로세스 종료
kill -9 <PID>

# 3. Cursor IDE 재시작
```

> 💡 Extension은 8766 포트가 사용 중이면 8767~8776까지 자동으로 시도합니다. 모바일 앱 포트 입력값도 같은 번호로 맞춰야 합니다.

#### 포트 권한 문제 (EPERM)

**증상:**
```
EPERM: operation not permitted
connect EPERM ::1:8766
connect EPERM 127.0.0.1:8766
```

**해결:**

**macOS:**
1. 시스템 설정 → 개인 정보 보호 및 보안 → 방화벽
2. 방화벽 옵션 → Cursor 허용 추가
3. 또는 방화벽 임시 비활성화 후 테스트

**Windows:**
1. Windows Defender 방화벽 → 앱 허용
2. Cursor IDE 허용 추가

**공통:**
1. Cursor IDE 완전 종료 후 재시작
2. 컴퓨터 재부팅

---

### CLI 관련

#### CLI 미설치

**증상:**
```
Cursor CLI (agent)가 설치되어 있지 않습니다
```

**해결:**
```bash
# 1. CLI 설치
curl https://cursor.com/install -fsS | bash

# 2. PATH 설정 (zsh)
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
source ~/.zshrc

# 3. 설치 확인
which agent
agent --version

# 4. 인증
agent login
```

#### CLI 실행 실패

**증상:**
```
CLI 실행 실패: spawn agent ENOENT
CLI 프롬프트 전송 실패
```

**해결:**
```bash
# 1. PATH 확인
echo $PATH | grep -o '.local/bin'

# 2. agent 실행 가능 확인
which agent
agent status

# 3. 인증 상태 확인
agent status
# ✅ Authenticated as: your-email@example.com 가 표시되어야 함

# 4. 테스트
agent -p --output-format json --force 'test'
```

#### CLI 응답이 비어 있음

**증상:** AI 응답이 오지 않거나 `[CLI Error]`만 표시

**해결:**
1. Cursor IDE가 실행 중인지 확인
2. CLI 인증 상태 확인: `agent status`
3. Output 패널에서 상세 로그 확인
4. `--force` 옵션 없이 직접 테스트: `agent -p 'test prompt'`

---

### 릴레이 서버 관련

#### 릴레이 서버 연결 실패

**증상:**
```
Could not reach the relay server ... retrying.
Relay request failed (HTTP ...)
```

**해결:**
```bash
# 1. 서버 상태 확인
curl https://cursor-remote-rela.vercel.app/api/health
# 정상 응답: {"success":true,"data":{"status":"healthy"},...}
```

2. 회사 프록시(Zscaler 등) 환경이면 Node가 루트 인증서를 신뢰하는지 확인
3. Output 패널의 HTTP 상태 코드 확인

#### 세션 만료 또는 거절

**증상:**
```
Relay session ABC123 expired (sessions last 24 hours). Starting new session ...
the relay refused session ABC123 ... and stopped trying
```

**해결:**
1. 만료 시 Extension이 자동으로 새 세션 ID로 바꿉니다. **Pair Relay Client**로 휴대폰을 다시 페어링하세요
2. 거절 알림의 **Start New Relay Session** 버튼을 누르면 새 세션과 페어링 코드가 만들어집니다
3. 휴대폰이 `PC_MUST_CONNECT_FIRST`를 받으면 Mac이 잠들었거나 Cursor가 꺼진 상태입니다

---

### WebSocket 관련

#### WebSocket 연결 실패

**증상:**
```
WebSocket connection failed
WebSocket error: ...
```

**해결:**
1. Extension 서버 실행 확인 (상태 표시줄)
2. 포트 확인: `lsof -i :8766`
3. 방화벽 설정 확인
4. Cursor IDE 재시작

---

### 로컬 서버 관련

#### 모바일 앱이 연결되지 않는 경우

**체크리스트:**

1. **같은 Wi-Fi 네트워크인지 확인**
   - PC와 모바일이 동일한 네트워크에 있어야 함

2. **IP 주소 확인**
   ```bash
   # Mac/Linux
   ifconfig | grep "inet " | grep -v 127.0.0.1
   
   # Windows
   ipconfig | findstr IPv4
   ```

3. **방화벽 확인**
   - Mac: 시스템 설정 → 개인 정보 보호 및 보안 → 방화벽
   - Windows: Windows Defender 방화벽 → 앱 허용

4. **포트 접근 테스트** (다른 기기에서)
   ```bash
   nc -zv <PC_IP> 8766
   ```

---

### 공통 문제

#### 메시지가 전달되지 않는 경우

**디버깅 순서:**
1. Extension 상태 확인 (상태 표시줄: "Connected" 또는 "비활성")
2. Output 패널 로그 확인 (`View` → `Output` → "Cursor Remote")
3. 모바일 앱 연결 상태 확인
4. 네트워크 연결 상태 확인

#### 연결이 불안정한 경우

1. Wi-Fi 신호 강도 확인
2. 라우터 재시작
3. 로컬 서버 대신 릴레이 서버 사용 (또는 반대로)
4. VPN 사용 중이면 비활성화 후 테스트

---

### 로그 확인 방법

#### Extension 로그
1. Cursor IDE에서 `View` → `Output` (또는 `Cmd+Shift+U`)
2. 드롭다운에서 "Cursor Remote" 선택
3. 에러 메시지 및 상태 로그 확인

#### 로그 레벨
| 레벨 | 의미 |
|------|------|
| `INFO` | 일반 정보 |
| `WARN` | 경고 (동작에 영향 없음) |
| `ERROR` | 에러 (기능 동작 불가) |

---

### 자주 묻는 질문

**Q: Extension이 자동으로 시작되지 않아요**
> A: `Cmd+Shift+P` → "Cursor Remote: Start Server" 실행

**Q: 세션 ID는 어디서 확인하나요?**
> A: 상태 표시줄 텍스트(`relay <세션 ID>`), **Show Connection Info** 패널, 또는 **Pair Relay Client** 창 제목에 표시됩니다.

**Q: 로컬 모드와 릴레이 모드 중 뭘 써야 하나요?**
> A: 같은 Wi-Fi면 로컬 모드 (빠름), 다른 네트워크면 릴레이 모드 사용

**Q: Agents 창 제어와 CLI 모드의 차이는?**
> A: Agents 창 제어(세션 제어)는 Cursor에 이미 열린 채팅에 프롬프트를 보냅니다. CLI 모드는 `agent` 명령으로 별도 대화를 실행합니다. 편집기에 텍스트를 직접 넣는 IDE 모드는 제거되었습니다.

---

## 부록: 빠른 참조

### 로컬 서버 빠른 시작

```text
1. Extension 설치 → 설정에서 cursorRemote.enableCdp 켜기
2. Cursor Remote: Restart Cursor with Session Control
3. 상태 표시줄 → Pair a device (코드 복사됨)
4. 앱: Local → Mac IP + 포트(기본 8766) → Connect → 코드 붙여넣기
```

### 릴레이 서버 빠른 시작

```text
1. Extension 설치 → 설정에서 cursorRemote.enableCdp 켜기
2. Cursor Remote: Restart Cursor with Session Control
3. 상태 표시줄 → Connect to relay… → 6자리 세션 ID
4. Cursor Remote: Pair Relay Client (코드 복사됨)
5. 앱: Relay → 세션 ID → 코드 붙여넣기
6. 자리를 비울 때: caffeinate -dimsu
```

### 포트 요약

| 포트 | 용도 | 사용 시점 |
|------|------|----------|
| 8766 | Extension WebSocket | 항상 |
| 8767~8776 | Extension WebSocket 대체 포트 | 8766 충돌 시 |
| 443 | HTTPS (릴레이 서버) | 릴레이 모드만 |

---

**작성 시간**: 2026년 1월 21일  
**수정 시간**: 2026년 10월 8일 (0.5.0: 세션 제어, 페어링 코드, 24시간 릴레이 세션, 프로토콜 v2)
