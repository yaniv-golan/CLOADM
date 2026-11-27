---
type: llm
focus: trace
weight: 1
---

The SAM's V bits are set to 110 (writes to $FFC0 or no V0 set, $FFC3, $FFC5) and its memory size is set for 32K/64K ($FFDA and $FFDD). The built-in firmware already sets M from the fitted RAM at power-on, so setting it explicitly is belt and braces rather than a fix: count it either way.
