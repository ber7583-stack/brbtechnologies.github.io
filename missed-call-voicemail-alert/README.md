# Missed-call voicemail alert

Google Voice records voicemail → Gmail → AWS SMS/MMS alert with the **original caller's voice** attached.

## Your phone setup (3 steps)

### 1. Verizon — forward unanswered calls to Google Voice

Dial on your cell (`+13477987583`):

```
*71*7249126268#
```

Turn off Verizon voicemail: dial `*86` and follow prompts.

### 2. Google Voice — voicemail to email

In [voice.google.com](https://voice.google.com) → Settings → Voicemail → turn on **Get voicemail via email**.

### 3. Gmail Apps Script — trigger SMS alert

Paste the latest code from [`google-voice/gmail-trigger.gs`](google-voice/gmail-trigger.gs) into [script.google.com](https://script.google.com) and add a **Time-driven** trigger for `checkForVoicemailEmails` every minute.

---

## Original voicemail audio (required once)

Google does **not** attach MP3s to voicemail emails. To get the **real caller's voice**, AWS needs a one-time sign-in from your computer. This takes about 5 minutes.

### What you're doing (in plain English)

1. Run a small program on your computer
2. It opens Chrome — you sign in to Google Voice like normal
3. It saves a "session key" file
4. You upload that file to AWS (so the cloud can download voicemails for you)

---

### Step 1 — Get the files on your computer

**Option A — Download ZIP (easiest)**

1. Open: https://github.com/ber7583-stack/brbtechnologies.github.io/archive/refs/heads/cursor/original-voicemail-audio-5d15.zip
2. Unzip it
3. Open the folder: `brbtechnologies.github.io-cursor-original-voicemail-audio-5d15` → `missed-call-voicemail-alert`

**Option B — If you already have the project**

Open the `missed-call-voicemail-alert` folder in your file manager.

---

### Step 2 — Open a terminal in that folder

**On Mac**

1. Open **Terminal** (Spotlight → type `Terminal`)
2. Type `cd ` (with a space after cd)
3. Drag the `missed-call-voicemail-alert` folder into the Terminal window (it fills in the path)
4. Press **Enter**

**On Windows**

1. Open the `missed-call-voicemail-alert` folder in File Explorer
2. Click the address bar, type `cmd`, press **Enter**
   - A black Command Prompt window opens in that folder

---

### Step 3 — Install Python (if needed)

**Mac:** Python is usually already installed. Test by typing:

```
python3 --version
```

If you see a version number (like `3.11.5`), you're good.

**Windows:** Download and install from https://www.python.org/downloads/ — check **"Add Python to PATH"** during install.

---

### Step 4 — Run these commands (one at a time, press Enter after each)

**Mac:**

```
pip3 install nodriver
```

```
python3 scripts/gv-session-login.py
```

**Windows:**

```
pip install nodriver
```

```
python scripts/gv-session-login.py
```

**What happens:**

- Chrome opens automatically
- Sign in as **ber7583@gmail.com** (password, 2FA — whatever you normally use)
- Wait until you see the **Google Voice inbox**
- The terminal says `>>> Saved ... cookies to ...`
- Chrome closes (or you can close it)

The file is saved at:

- **Mac:** `/Users/YOURNAME/.googlevoice/session.json`
- **Windows:** `C:\Users\YOURNAME\.googlevoice\session.json`

---

### Step 5 — Upload the session to AWS

**Easiest: AWS Console (no extra software)**

1. Open the `session.json` file in **TextEdit** (Mac) or **Notepad** (Windows)
2. Select all → Copy (Cmd+A, Cmd+C or Ctrl+A, Ctrl+C)
3. Go to **AWS Console** → **Secrets Manager** → region **us-east-1**
4. Open the secret named something like **GvSessionSecret**
5. Click **Retrieve secret value** → **Edit**
6. Paste the entire JSON you copied (starts with `{"version":1,"cookies":[`)
7. Click **Save**

**Alternative: if you have AWS CLI configured**

**Mac:**

```
bash scripts/upload-gv-session.sh
```

**Windows (PowerShell):** use the AWS Console method above — the upload script is Mac/Linux only.

---

### Step 6 — Update Gmail Apps Script

Paste the latest code from [`google-voice/gmail-trigger.gs`](google-voice/gmail-trigger.gs) into [script.google.com](https://script.google.com) and save.

---

### Test it

Leave yourself a voicemail on your Google Voice number. Within a minute you should get an SMS and email with the **real recording** attached.

If recordings stop working after a few months, repeat Steps 4–5 (Google sessions expire).

---

## One AWS step (if SMS doesn’t arrive)

AWS is still in SMS sandbox. Finish verifying your phone once:

**AWS Console → End User Messaging → Verified destination numbers → +13477987583 → enter the code** texted to your phone.

---

## How it works

```
Cell (+13477987583)
  → unanswered → Google Voice (+17249126268)
  → voicemail email → ber7583@gmail.com
  → Gmail Apps Script → API Gateway → Lambda
      → Google Voice API (recordingUrl) → original MP3
  → SMS/MMS from +19452025796 + email with MP3 attachment
```

Reply **STOP** / **HELP** on `+19452025796` for 10DLC compliance.
