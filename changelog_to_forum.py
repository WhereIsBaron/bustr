#!/usr/bin/env python3
"""Regenerate CHANGELOG_FORUM.html from CHANGELOG.md.

The Torn forum editor is HTML-based, not markdown/BBCode: pasting the markdown
changelog leaves literal ##, -, ** and backticks, and collapses whitespace. This
converts the canonical CHANGELOG.md into paste-ready HTML (version headers as bold
paragraphs, entries as <ul>/<li>, `code` as <code>, **bold** as <strong>, *italic*
as <em>, with &<> escaped). Paste the output via the forum editor's Source Code (</>)
button.

The forum copy is CONDENSED, not a 1:1 render: forum readers want "what changed and
does it affect me" at a glance, not the full engineering rationale. Each top-level
entry is reduced to its one-line summary - the bold **headline** if it has one, else
its first sentence - and the deep-dive sub-bullets are dropped. CHANGELOG.md itself
stays fully detailed (that is the canonical GitHub record); only this forum view is
trimmed. To shorten a forum line, lead the CHANGELOG.md bullet with a tight **bold
headline** and the long explanation after it is automatically left off the forum.

Run from the repo root:  python changelog_to_forum.py
Regenerate whenever CHANGELOG.md changes, same as CHANGELOG_DISCORD.txt.
"""
import re
import os

ROOT = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(ROOT, "CHANGELOG.md")
DST = os.path.join(ROOT, "CHANGELOG_FORUM.html")

# A top-level entry line:  "- [TAG] body"  (the [TAG] is optional).
BULLET_RE = re.compile(r"^- (\[[A-Z]+\]\s+)?(.*)$")
# Any indented detail line (two or more leading spaces): a nested sub-bullet OR a
# continuation paragraph under a bullet. Both are deep detail, dropped from the forum
# view. Version headers and intro paragraphs always start at column 0, so this never
# catches anything the forum should keep.
INDENTED_DETAIL_RE = re.compile(r"^\s{2,}\S")
# A leading **bold headline** at the start of a bullet body.
BOLD_LEAD_RE = re.compile(r"^\*\*(.+?)\*\*")
# End of the first sentence: a word char (then an optional closing bracket/quote),
# a period, whitespace, then a capital. Written so decimals and version numbers
# like "0.6" or "v2.8.0" and abbreviations don't count as sentence ends.
SENTENCE_END_RE = re.compile(r"[a-z0-9][\)\]\"']?\.(\s+)(?=[A-Z])")


def first_sentence(s):
    """The first sentence of s (through its terminal period), else s unchanged."""
    m = SENTENCE_END_RE.search(s)
    if m:
        period_idx = m.start(1) - 1  # the '.' sits just before the whitespace group
        return s[: period_idx + 1].rstrip()
    return s


def condense(lines):
    """Trim CHANGELOG.md to a scannable forum view before HTML conversion.

    Keeps version headers, the intro paragraph, and each top-level entry reduced to
    one line (its bold headline, or its first sentence). Drops the nested sub-bullets.
    """
    out = []
    for raw in lines:
        line = raw.rstrip("\n")
        if INDENTED_DETAIL_RE.match(line):
            continue  # deep-dive detail - not for the forum
        m = BULLET_RE.match(line)
        if m:
            tag = m.group(1) or ""
            body = m.group(2).strip()
            bold = BOLD_LEAD_RE.match(body)
            if bold:
                body = "**" + bold.group(1).strip() + "**"
            else:
                body = first_sentence(body)
            out.append("- " + tag + body)
        else:
            out.append(line)  # header, blank line, or intro paragraph: keep as-is
    return out


def inline(s):
    # Escape HTML specials FIRST, then apply the markdown -> HTML conversions.
    s = s.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    s = re.sub(r"\*\*(.+?)\*\*", r"<strong>\1</strong>", s)
    s = re.sub(r"`([^`]+)`", r"<code>\1</code>", s)
    s = re.sub(r"(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)", r"<em>\1</em>", s)
    return s


def convert(lines):
    out = []
    state = {"top": False, "li": False, "sub": False}

    def close_sub():
        if state["sub"]:
            out.append("</ul>")
            state["sub"] = False

    def close_li():
        close_sub()
        if state["li"]:
            out.append("</li>")
            state["li"] = False

    def close_top():
        close_li()
        if state["top"]:
            out.append("</ul>")
            state["top"] = False

    for raw in lines:
        line = raw.rstrip("\n")
        if line.startswith("# ") or line.strip() == "---":
            continue
        if line.startswith("## "):
            close_top()
            out.append("<p><strong>" + inline(line[3:].strip()) + "</strong></p>")
            continue
        if re.match(r"^- ", line):
            if not state["top"]:
                out.append("<ul>")
                state["top"] = True
            else:
                close_li()
            out.append("<li>" + inline(line[2:].strip()))
            state["li"] = True
            continue
        if re.match(r"^\s{2,}- ", line):
            if not state["sub"]:
                out.append("<ul>")
                state["sub"] = True
            out.append("<li>" + inline(line.split("- ", 1)[1].strip()) + "</li>")
            continue
        if line.strip() == "":
            continue
        close_top()
        out.append("<p>" + inline(line.strip()) + "</p>")

    close_top()
    return "\n".join(out) + "\n"


def main():
    with open(SRC, encoding="utf-8") as fh:
        html = convert(condense(fh.read().splitlines()))
    with open(DST, "w", encoding="utf-8") as fh:
        fh.write(html)
    print("wrote", os.path.basename(DST))


if __name__ == "__main__":
    main()
