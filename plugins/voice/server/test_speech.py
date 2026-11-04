from speech import SentenceStream, clean


def test_clean_drops_code_paths_and_markup():
    t = "## Kész\nA `useEffect` hookot javítottam: **fontos**.\n```ts\nconst a = 1;\n```\nLásd /Users/adam/work/x.ts és https://x.io/a."
    c = clean(t)
    assert "const" not in c and "/Users" not in c and "https" not in c and "**" not in c and "#" not in c
    assert "useEffect" in c and "Kész" in c


def test_stream_emits_sentences_and_holds_open_fence():
    s = SentenceStream(min_len=1)
    out = s.feed("Első mondat. Második ")
    assert out == ["Első mondat."]
    assert s.feed("mondat.\n\n```py\nprint(1)\n") == []
    out = s.feed("```\nHarmadik.")
    assert "Második mondat." in out[0]
    assert s.flush() == ["Harmadik."]


def test_short_fragments_are_merged():
    s = SentenceStream(min_len=12)
    assert s.feed("Ok. Ez egy hosszabb mondat.") == []
    assert s.flush() == ["Ok. Ez egy hosszabb mondat."]
