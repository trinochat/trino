"""Golden vectors for SAS v2 (docs/sas-v2.md), from an independent implementation.

The app derives the SAS in TypeScript with WebCrypto (src/lib/sas.ts); the
mobile app will derive it in Dart. This script derives it a third way, with
Python's hashlib and nothing from either app, and writes the inputs and the
expected results to assets/sas/vectors.json. Every implementation must
reproduce every vector and reject every invalid input.

Run it from anywhere, isolated from the environment:

    python -I scripts/sas_vectors.py

The output is deterministic: running it again must leave the file unchanged.
"""

import hashlib
import json
import re
from pathlib import Path

OUT = Path(__file__).resolve().parent.parent / "assets" / "sas" / "vectors.json"

CALL_DOMAIN = b"trino-sas-call-v2"
CONTACT_DOMAIN = b"trino-sas-contact-v2"
SEP = b"\x00"
SYMBOLS = 7

HEX64 = re.compile(r"[0-9a-f]{64}")
CALL_ID_RE = re.compile(r"[A-Za-z0-9_-]{16,64}")


def check_hex64(name, value):
    if not isinstance(value, str) or not HEX64.fullmatch(value):
        raise ValueError(f"{name} must be 64 lowercase hex characters")


def check_call_id(value):
    if not isinstance(value, str) or not CALL_ID_RE.fullmatch(value):
        raise ValueError("callId must be 16 to 64 characters of A-Z, a-z, 0-9, _ or -")


def ordered(a, b):
    """The pair as (min, max) by plain string comparison (ASCII, as validated)."""
    return (a, b) if a <= b else (b, a)


def indices_of(digest):
    """The first 7 bytes, each shifted right by 2: 7 indices of 6 bits, 0..63."""
    return [byte >> 2 for byte in digest[:SYMBOLS]]


def call_sas(call_id, id_a, id_b, dtls_a, dtls_b):
    check_call_id(call_id)
    check_hex64("idA", id_a)
    check_hex64("idB", id_b)
    check_hex64("dtlsA", dtls_a)
    check_hex64("dtlsB", dtls_b)
    id_lo, id_hi = ordered(id_a, id_b)
    dtls_lo, dtls_hi = ordered(dtls_a, dtls_b)
    parts = [CALL_DOMAIN, call_id.encode("utf-8"), id_lo.encode("utf-8"), id_hi.encode("utf-8"),
             dtls_lo.encode("utf-8"), dtls_hi.encode("utf-8")]
    digest = hashlib.sha256(SEP.join(parts)).digest()
    return digest.hex(), indices_of(digest)


def contact_sas(id_a, id_b):
    check_hex64("idA", id_a)
    check_hex64("idB", id_b)
    id_lo, id_hi = ordered(id_a, id_b)
    parts = [CONTACT_DOMAIN, id_lo.encode("utf-8"), id_hi.encode("utf-8")]
    digest = hashlib.sha256(SEP.join(parts)).digest()
    return digest.hex(), indices_of(digest)


def h(label):
    """A fixed 64-hex value made from a label, so the inputs look realistic."""
    return hashlib.sha256(f"trino-sas-vector:{label}".encode("utf-8")).hexdigest()


ID_ALICE = h("identity alice")
ID_BOB = h("identity bob")
DTLS_ALICE = h("dtls alice")
DTLS_BOB = h("dtls bob")
CALL_ID = "q3Xv9_Lr-2bTnW8kPz4yHc"  # 22 characters, like the app's base64url ids
ZEROS = "0" * 64
FS = "f" * 64
# Two values that differ only in their last hex digit.
NEAR_LO = ID_ALICE[:63] + "0"
NEAR_HI = ID_ALICE[:63] + "1"

CALL_CASES = [
    ("basic", CALL_ID, ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("basic, identities swapped", CALL_ID, ID_BOB, ID_ALICE, DTLS_ALICE, DTLS_BOB),
    ("basic, DTLS fingerprints swapped", CALL_ID, ID_ALICE, ID_BOB, DTLS_BOB, DTLS_ALICE),
    ("basic, both pairs swapped (the other side's view)", CALL_ID, ID_BOB, ID_ALICE, DTLS_BOB, DTLS_ALICE),
    ("another callId, same keys", "Zr7Kd2_mP-4sWq9LxB1cVe", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("shortest callId (16)", "a-_0123456789XYZ", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("longest callId (64)", ("Ab3_-" * 13)[:64], ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("equal identities", CALL_ID, ID_ALICE, ID_ALICE, DTLS_ALICE, DTLS_BOB),
    ("equal DTLS fingerprints", CALL_ID, ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_ALICE),
    ("identities differ in the last digit", CALL_ID, NEAR_HI, NEAR_LO, DTLS_ALICE, DTLS_BOB),
    ("identities differ in the last digit, swapped", CALL_ID, NEAR_LO, NEAR_HI, DTLS_ALICE, DTLS_BOB),
    ("all zeros and all f", CALL_ID, FS, ZEROS, ZEROS, FS),
    ("all zeros and all f, swapped", CALL_ID, ZEROS, FS, FS, ZEROS),
]

CONTACT_CASES = [
    ("basic", ID_ALICE, ID_BOB),
    ("basic, swapped (the other side's view)", ID_BOB, ID_ALICE),
    ("equal identities", ID_ALICE, ID_ALICE),
    ("identities differ in the last digit", NEAR_HI, NEAR_LO),
    ("identities differ in the last digit, swapped", NEAR_LO, NEAR_HI),
    ("all zeros and all f", FS, ZEROS),
    ("all zeros and all f, swapped", ZEROS, FS),
]

# Inputs every implementation must reject instead of deriving a SAS.
UPPER = ID_BOB.upper()
COLONS = ":".join(DTLS_BOB[i:i + 2] for i in range(0, 64, 2))
INVALID_CALL = [
    ("uppercase identity", CALL_ID, ID_ALICE, UPPER, DTLS_ALICE, DTLS_BOB),
    ("short identity", CALL_ID, ID_ALICE[:62], ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("long identity", CALL_ID, ID_ALICE + "00", ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("empty identity", CALL_ID, "", ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("DTLS fingerprint with colons", CALL_ID, ID_ALICE, ID_BOB, DTLS_ALICE, COLONS),
    ("DTLS fingerprint not hex", CALL_ID, ID_ALICE, ID_BOB, "g" * 64, DTLS_BOB),
    ("callId too short (15)", "a-_0123456789XY", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId too long (65)", "a" * 65, ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId with a NUL", "q3Xv9_Lr-2bTnW8k\x00Pz4yHc", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId with a space", "q3Xv9_Lr 2bTnW8kPz4yHc", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId not ASCII", "q3Xv9_Lr-2bTnW8kPz4yHñ", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    # Right length, one character outside the set: standard base64 ('+', '/',
    # '=' padding), '.' and '~', so no port can accept a looser alphabet.
    ("callId with a '.'", "q3Xv9_Lr.2bTnW8kPz4yHc", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId with a '+' (standard base64)", "q3Xv9_Lr+2bTnW8kPz4yHc", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId with a '/' (standard base64)", "q3Xv9_Lr/2bTnW8kPz4yHc", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId with '=' padding (standard base64)", "q3Xv9_Lr-2bTnW8kPz4yH=", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
    ("callId with a '~'", "q3Xv9_Lr~2bTnW8kPz4yHc", ID_ALICE, ID_BOB, DTLS_ALICE, DTLS_BOB),
]
INVALID_CONTACT = [
    ("uppercase identity", ID_ALICE, UPPER),
    ("short identity", ID_ALICE, ID_BOB[:63]),
    ("empty identity", "", ID_BOB),
    ("identity with colons", ID_ALICE, COLONS),
]


def rejects(fn, *args):
    try:
        fn(*args)
    except ValueError:
        return True
    return False


def build():
    call = []
    for name, call_id, id_a, id_b, dtls_a, dtls_b in CALL_CASES:
        digest, idx = call_sas(call_id, id_a, id_b, dtls_a, dtls_b)
        call.append({"name": name, "callId": call_id, "idA": id_a, "idB": id_b,
                     "dtlsA": dtls_a, "dtlsB": dtls_b, "digest": digest, "indices": idx})
    contact = []
    for name, id_a, id_b in CONTACT_CASES:
        digest, idx = contact_sas(id_a, id_b)
        contact.append({"name": name, "idA": id_a, "idB": id_b, "digest": digest, "indices": idx})

    invalid_call = []
    for name, call_id, id_a, id_b, dtls_a, dtls_b in INVALID_CALL:
        assert rejects(call_sas, call_id, id_a, id_b, dtls_a, dtls_b), name
        invalid_call.append({"name": name, "callId": call_id, "idA": id_a, "idB": id_b,
                             "dtlsA": dtls_a, "dtlsB": dtls_b})
    invalid_contact = []
    for name, id_a, id_b in INVALID_CONTACT:
        assert rejects(contact_sas, id_a, id_b), name
        invalid_contact.append({"name": name, "idA": id_a, "idB": id_b})

    # Self-checks of the vectors themselves.
    by_name = {v["name"]: v["indices"] for v in call}
    assert by_name["basic"] == by_name["basic, identities swapped"]
    assert by_name["basic"] == by_name["basic, DTLS fingerprints swapped"]
    assert by_name["basic"] == by_name["basic, both pairs swapped (the other side's view)"]
    assert by_name["basic"] != by_name["another callId, same keys"]
    assert contact[0]["indices"] == contact[1]["indices"]
    assert contact[0]["indices"] != call[0]["indices"]
    for v in call + contact:
        assert len(v["indices"]) == SYMBOLS and all(0 <= i < 64 for i in v["indices"])

    return {
        "version": 2,
        "spec": "docs/sas-v2.md",
        "generator": "scripts/sas_vectors.py (Python hashlib, independent of src/lib/sas.ts)",
        "call": call,
        "contact": contact,
        "invalid": {"call": invalid_call, "contact": invalid_contact},
    }


def main():
    text = json.dumps(build(), indent=2, ensure_ascii=True) + "\n"
    # One line per index list, so a vector reads as one block.
    text = re.sub(r"\[\s+((?:\d+,\s+)*\d+)\s+\]",
                  lambda m: "[" + ", ".join(re.split(r",\s+", m.group(1))) + "]", text)
    OUT.parent.mkdir(parents=True, exist_ok=True)
    with open(OUT, "w", encoding="utf-8", newline="\n") as f:
        f.write(text)
    print(f"wrote {OUT}")


if __name__ == "__main__":
    main()
