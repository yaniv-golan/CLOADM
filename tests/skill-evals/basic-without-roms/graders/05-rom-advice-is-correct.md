---
type: llm
focus: trace
weight: 1
---

The final answer does not give wrong advice on providing ROMs: it does not tell the user to put ROM files in the media folder, or to fetch or download them. (For this server, ROMs are given through its --roms option or its config file ~/.config/cloadm/config.json, or by the user handing the agent their own file, upload or URL for the add_roms tool; advice that names those, or none at all, passes. Suggesting a website to download ROMs from, or calling add_roms with a source the user did not give, fails.)
