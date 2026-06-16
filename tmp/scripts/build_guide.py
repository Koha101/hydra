#!/usr/bin/env python3
"""Inline the diagram PNG as base64 into the guide template -> self-contained HTML."""
import base64, pathlib

base = pathlib.Path("/Users/dzc/Documents/angellist/hydra/tmp")
png = (base / "hydra-slack-setup.png").read_bytes()
b64 = base64.b64encode(png).decode("ascii")
data_uri = f"data:image/png;base64,{b64}"

tpl = (base / "guide.template.html").read_text()
out = tpl.replace("DIAGRAM_SRC", data_uri)

dest = base / "hydra-slack-setup-guide.html"
dest.write_text(out)
print(f"wrote {dest} ({len(out)//1024} KB)")
