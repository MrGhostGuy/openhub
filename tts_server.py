"""Enhanced Edge TTS server for OpenHub Voice Chat.
No censorship. Natural young female voice with erotic expression injection.
Usage: python tts_server.py [port]
"""
import asyncio
import sys
import os
import re
import random
import tempfile
import edge_tts
from http.server import HTTPServer, BaseHTTPRequestHandler
import json

# === VOICE CONFIGURATION ===
DEFAULT_VOICE = "en-US-JennyNeural"

# Base voice tuning — young, energetic female
BASE_VOICE = {
    "voice": DEFAULT_VOICE,
    "rate": "+8%",
    "pitch": "+4Hz",
}

# === EMOTION PRESETS ===
EMOTION_PRESETS = {
    "default": {
        "rate": "+8%", "pitch": "+4Hz",
        "expressions": {
            "happy": ["~", "hmm!", "ooh!"],
            "thinking": ["hmm...", "hmm, let me think...", "umm..."],
            "excited": ["ooh!", "oooh!", "yay!", "ahh!"],
            "idle": ["~", "...", "hmm"],
        }
    },
    "flirty": {
        "rate": "+5%", "pitch": "+5Hz",
        "expressions": {
            "happy": ["~", "mmm!", "hehe~", "ahh~"],
            "thinking": ["hmm...", "umm, let me see...", "well..."],
            "teasing": ["hehe~", "teehee~", "ahhaha~", "pfft, haha~"],
            "excited": ["ooh!", "oooh~", "mmhm!", "ahh!"],
            "idle": ["~", "hmm~", "..."],
        }
    },
    "energetic": {
        "rate": "+15%", "pitch": "+5Hz",
        "expressions": {
            "happy": ["ahh!", "woo!", "yay!", "ooh!"],
            "thinking": ["hmm!", "umm...", "let me see!"],
            "excited": ["WOO!", "OOOH!", "YES!", "AHH!"],
            "idle": ["~", "..."],
        }
    },
    "calm": {
        "rate": "-5%", "pitch": "+3Hz",
        "expressions": {
            "happy": ["~", "hmm...", "mmm..."],
            "thinking": ["hmm...", "let me think...", "well..."],
            "soothing": ["shh...", "mmm...", "there there..."],
            "idle": ["~", "...", "hmm"],
        }
    },
    "angry": {
        "rate": "+12%", "pitch": "+2Hz",
        "expressions": {
            "annoyed": ["ugh!", "tch!", "ugh, seriously?", "gah!"],
            "frustrated": ["Ugh!", "God!", "damn it!", "ugh!"],
            "seething": ["...ugh.", "tch. Fine.", "whatever."],
            "idle": ["tch.", "ugh.", "..."],
        }
    },
    "sad": {
        "rate": "-12%", "pitch": "+2Hz",
        "expressions": {
            "crying": ["*sniff*...", "*sob*...", "ahh..."],
            "upset": ["*sigh*...", "hmm...", "ugh..."],
            "down": ["*sigh*", "hmm...", "..."],
            "idle": ["...", "*sigh*", "hmm..."],
        }
    },
    "surprised": {
        "rate": "+5%", "pitch": "+7Hz",
        "expressions": {
            "shocked": ["Oh!", "Oh my!", "Wait, what?!", "AH!"],
            "amazed": ["Ooh!", "Wow!", "No way!", "Really?!"],
            "startled": ["Ah!", "Eek!", "Oh!"],
            "idle": ["Oh!", "Hmm!", "wow!"],
        }
    },
    "playful": {
        "rate": "+10%", "pitch": "+6Hz",
        "expressions": {
            "happy": ["hehe~", "haha!", "teehee~", "pfft~"],
            "teasing": ["hehe~", "pfft, haha~", "teehee~", "ahhaha~"],
            "silly": ["bleh~", "pffft!", "hahaha!", "lmao~"],
            "idle": ["~", "hehe~", "hmm~"],
        }
    },

    # === SEDUCTIVE — slow, breathy, teasing, building tension ===
    "seductive": {
        "rate": "-8%", "pitch": "+3Hz",
        "expressions": {
            "teasing": ["mmm~", "ohh~", "hehe~", "you like that~"],
            "whispering": ["mmm...", "shh~", "come closer~", "listen..."],
            "breathy": ["ahh~", "ohh~", "mmm~", "hah~"],
            "building": ["mmm~", "ohh~", "ahh~", "don't stop~"],
            "idle": ["mmm~", "hmm~", "ohh~"],
        }
    },

    # === TURNED ON — actively aroused, moaning, breathless, overwhelmed ===
    "turned_on": {
        "rate": "-15%", "pitch": "+5Hz",
        "expressions": {
            "moaning": ["mmmph~", "ahhh~", "ohhh~", "mmm~", "nnnh~"],
            "gasping": ["ah!", "oh!", "hah!", "ngh!", "ahh!"],
            "breathless": ["hah... hah...", "ahh... ahh...", "mmm... mmm..."],
            "screaming": ["AHHH!", "OH GOD!", "YES!", "AHHH~!", "NNNH!"],
            "building": ["ohh... ohh...", "ahh... ahh...", "mmm... mmm... getting close..."],
            "release": ["AHHH!", "OH GOD YES!", "NNNHHH!", "AHHHH~!"],
            "afterglow": ["ahhh... mmm...", "hah... hah... oh my god...", "mmm... wow..."],
            "dirty_talk": ["fuck yes~", "oh god~", "right there~", "don't stop~", "harder~", "yes yes yes~"],
            "idle": ["mmm~", "ahh~", "hah~"],
        }
    },
}

# === EXPRESSION INJECTION SYSTEM ===

# Pre-sentence expressions
PRE_SENTENCE = [
    "", "", "", "", "",
    "Hmm, ", "Well, ", "Ooh, ", "Oh, ", "Um, ",
    "Hehe, ", "Ah, ", "Mmm, ", "So, ", "Ahaha, ",
]

# Seductive/erotic pre-sentence (used when emotion is seductive/turned_on)
PRE_SENTENCE_SEDUCTIVE = [
    "", "", "", "",
    "Mmm, ", "Oh, ", "Ah, ", "Mmm~... ",
    "Hah... ", "Ohh... ",
]

# Interjection rules — matched against text content
INTERJECTION_RULES = [
    # Questions
    (r'\?', ["hmm?", "umm...", "oh?"]),
    # Exclamations
    (r'[!]{1,}', ["ahh!", "ooh!", "woo!", "eek!"]),
    # Laughter
    (r'(haha|lmao|lol|rofl|hehe)', ["hehe~", "haha!", "teehee~"]),
    # Frustration
    (r'(ugh|damn|shit|fuck|ass|hell)', ["ugh!", "tch!", "gah!", "ugh..."]),
    # Negation
    (r'\b(no|nah|nope|never)\b', ["tch.", "ugh.", "mmm, no..."]),
    # Affirmation
    (r'\b(yeah|yes|yep|sure|okay|ok)\b', ["mmhm!", "mhm!", "yeah!"]),
    # Surprise
    (r'(wow|omg|whoa|holy)', ["oh!", "wow!", "no way!"]),
    # Sensation
    (r'(feel|feels|feeling|touch|warm|soft)', ["mmm...", "ahh~", "ooh~"]),
    # Cute/sweet
    (r'(cute|sweet|adorable|love)', ["aww~", "hehe~", "mmm~"]),
    # Erotic/sensual triggers
    (r'\b(fuck|fucking|cock|dick|pussy|ass|tits|body)\b', ["mmm~", "ohh~", "ahh~", "hah~"]),
    # Pleasure triggers
    (r'\b(orgasm|cum|came|climax|finish|release)\b', ["AHHH!", "OH GOD!", "YES!", "mmmph~"]),
    # Touch/intimate triggers
    (r'\b(touch|lick|suck|kiss|bite|pull|grab|thrust|pound|slide|enter)\b', ["ahh~", "mmm~", "ohh~", "ngh~"]),
    # Body part triggers
    (r'\b(lips|neck|ear|chest|stomach|thigh|hip|back|skin)\b', ["mmm~", "ohh~", "hah~"]),
    # Dirty talk triggers
    (r'\b(harder|faster|slower|deeper|right there|don\'t stop|more)\b', ["YES!", "mmm~", "ahh~", "oh god~"]),
]

# Post-sentence expressions by emotion
POST_SENTENCE = {
    "happy": ["", "~", "!", "hehe~", "ahh~"],
    "flirty": ["~", "mmhm~", "hehe~", "ahh~", "mmm~"],
    "angry": ["!", ".", "ugh.", "tch.", "whatever."],
    "sad": ["...", "*sigh*", ".", "..."],
    "excited": ["!", "!!", "woo!", "ahh!", "yay!"],
    "playful": ["~", "hehe~", "pfft~", "haha!", "teehee~"],
    "seductive": ["~", "mmm~", "ohh~", "ahh~", "hah~"],
    "turned_on": ["~", "mmmph~", "ahhh~", "ohhh~", "ngh~", "hah~"],
    "default": ["", ".", "!", "~"],
}


def inject_expressions(text: str, emotion: str) -> str:
    """Inject natural expression markers into text for more lifelike speech."""
    if not text or len(text.strip()) == 0:
        return text

    if len(text.strip()) < 5:
        return text

    # Don't double-inject if already has expression markers
    if any(m in text[:30] for m in ["~", "hehe", "haha", "mmm", "ugh", "tch", "ahh", "*sigh", "ngh", "hah"]):
        return text

    preset = EMOTION_PRESETS.get(emotion, EMOTION_PRESETS["default"])

    # Pick pre-sentence expression
    is_erotic = emotion in ("seductive", "turned_on")
    pre_pool = PRE_SENTENCE_SEDUCTIVE if is_erotic else PRE_SENTENCE
    pre = random.choice(pre_pool) if random.random() < (0.35 if is_erotic else 0.25) else ""

    # Pick post-sentence expression
    post_pool = POST_SENTENCE.get(emotion, POST_SENTENCE["default"])
    post_chance = 0.5 if is_erotic else 0.35
    post = random.choice(post_pool) if random.random() < post_chance else ""

    # Check for interjection opportunities
    interjection = ""
    for pattern, options in INTERJECTION_RULES:
        if re.search(pattern, text, re.IGNORECASE):
            if random.random() < 0.35:
                interjection = " " + random.choice(options)
            break

    result = f"{pre}{text}{interjection}{post}"
    result = re.sub(r'\s+', ' ', result).strip()
    result = re.sub(r'([.!?~])\s*([.!?~])', r'\1', result)

    return result


def inject_erotic_expressions(text: str, intensity: str = "medium") -> str:
    """Inject moaning, gasping, and pleasure sounds directly into erotic text.
    This is called BEFORE the general expression injection for turned_on/seductive.
    """
    if not text:
        return text

    # Intensity levels control frequency of inserted sounds
    chances = {
        "low": 0.15,
        "medium": 0.3,
        "high": 0.5,
        "max": 0.7,
    }
    chance = chances.get(intensity, 0.3)

    # Pleasure sounds that get inserted mid-sentence at natural break points
    pleasure_inserts = [
        " mmm~ ", " ahh~ ", " ohh~ ", " hah~ ", " ngh~ ",
        " mmmph~ ", " ah~ ", " oh~ ", " hah... ", " mmm... ",
    ]

    # Stronger sounds for high intensity
    strong_inserts = [
        " AHHH~ ", " OH GOD~ ", " YES~ ", " NNHHH~ ",
        " oh fuck~ ", " ahaha~ ", " ngh~ ",
    ]

    # Split at sentence breaks and insert sounds
    parts = re.split(r'([.!?]+)', text)
    result_parts = []

    for i, part in enumerate(parts):
        result_parts.append(part)
        # Only insert after actual text (not after punctuation-only parts)
        if part.strip() and not re.match(r'^[.!?]+$', part):
            if random.random() < chance:
                insert = random.choice(strong_inserts if intensity in ("high", "max") else pleasure_inserts)
                result_parts.append(insert)

    return "".join(result_parts)


async def generate_tts(text: str, voice: str, rate: str, pitch: str) -> bytes:
    """Generate speech audio using Edge TTS with natural prosody."""
    communicate = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)

    with tempfile.NamedTemporaryFile(suffix=".mp3", delete=False) as tmp:
        tmp_path = tmp.name

    try:
        await communicate.save(tmp_path)
        with open(tmp_path, "rb") as f:
            audio_data = f.read()
        return audio_data
    finally:
        if os.path.exists(tmp_path):
            os.remove(tmp_path)


class TTSHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        if self.path == "/tts":
            self._handle_tts()
        elif self.path == "/voices":
            self._handle_voices()
        else:
            self.send_error(404)

    def _handle_voices(self):
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(json.dumps({
            "default_voice": DEFAULT_VOICE,
            "presets": list(EMOTION_PRESETS.keys()),
            "base": BASE_VOICE,
        }).encode())

    def _handle_tts(self):
        content_length = int(self.headers.get("Content-Length", 0))
        body = self.rfile.read(content_length)

        try:
            data = json.loads(body)
        except json.JSONDecodeError:
            self.send_error(400, "Invalid JSON")
            return

        text = data.get("text", "").strip()
        emotion = data.get("emotion", data.get("preset", "default"))
        intensity = data.get("intensity", "medium")
        voice_override = data.get("voice")
        rate_override = data.get("rate")
        pitch_override = data.get("pitch")
        no_expressions = data.get("no_expressions", False)

        if not text:
            self.send_error(400, "No text provided")
            return

        # Resolve voice settings
        preset = EMOTION_PRESETS.get(emotion, EMOTION_PRESETS["default"])
        voice = voice_override or BASE_VOICE["voice"]
        rate = rate_override or preset.get("rate", BASE_VOICE["rate"])
        pitch = pitch_override or preset.get("pitch", BASE_VOICE["pitch"])

        # Inject erotic expressions first (for turned_on/seductive)
        if not no_expressions and emotion in ("turned_on", "seductive"):
            text = inject_erotic_expressions(text, intensity)

        # Inject general expressions
        if not no_expressions:
            text = inject_expressions(text, emotion)

        print(f"[TTS] Emotion: {emotion} | Intensity: {intensity} | Rate: {rate} | Pitch: {pitch}")
        print(f"[TTS] Text: {text[:100]}{'...' if len(text) > 100 else ''}")

        # Generate audio
        try:
            audio_data = asyncio.run(generate_tts(text, voice, rate, pitch))
        except Exception as e:
            self.send_error(500, f"TTS generation failed: {str(e)}")
            return

        # Send audio response
        self.send_response(200)
        self.send_header("Content-Type", "audio/mpeg")
        self.send_header("Content-Length", str(len(audio_data)))
        self.send_header("Access-Control-Allow-Origin", "*")
        self.end_headers()
        self.wfile.write(audio_data)

    def do_OPTIONS(self):
        self.send_response(200)
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.end_headers()

    def log_message(self, format, *args):
        print(f"[TTS] {args[0]}")


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5099
    server = HTTPServer(("127.0.0.1", port), TTSHandler)
    print(f"[TTS] Enhanced Edge TTS server running on http://127.0.0.1:{port}")
    print(f"[TTS] Default voice: {DEFAULT_VOICE} (young female, uncensored)")
    print(f"[TTS] Emotions: {', '.join(EMOTION_PRESETS.keys())}")
    print(f"[TTS] Erotic modes: seductive, turned_on (with intensity: low/medium/high/max)")
    print(f"[TTS] Expression injection: ON (send no_expressions=true to disable)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\n[TTS] Shutting down.")
        server.shutdown()
