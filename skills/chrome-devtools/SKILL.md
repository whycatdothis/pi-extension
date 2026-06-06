---
name: chrome-devtools
description: Full control of Chrome browser via Chrome DevTools MCP. Use when user asks to browse the web, open a URL, fill forms, click buttons, take screenshots, inspect network/console, run Lighthouse audits, performance traces, or any browser automation task.
---

# Chrome DevTools Skill

Control Chrome via `mcporter call chrome-devtools.<tool>`.

Run `mcporter list chrome-devtools --schema` to see all 29 tools with full parameter schemas.

## Core Tools

### Page
```bash
mcporter call chrome-devtools.list_pages                                    # list open pages
mcporter call chrome-devtools.select_page pageId:<n> bringToFront:true      # switch page
mcporter call chrome-devtools.new_page url:"https://example.com"            # open new tab
mcporter call chrome-devtools.navigate_page type:"url" url:"..."            # nav/back/forward/reload
```

### Snapshot — ALWAYS call first to get element `uid`s
```bash
mcporter call chrome-devtools.take_snapshot                                 # a11y tree with uid
mcporter call chrome-devtools.take_screenshot format:"png" fullPage:true    # screenshot
```

### Interaction — all need `uid` from snapshot
```bash
mcporter call chrome-devtools.click uid:"1_5"                               # click element
mcporter call chrome-devtools.fill uid:"1_3" value:"text"                   # fill input/checkbox
mcporter call chrome-devtools.fill_form elements:'[{"uid":"1_3","value":"a"},{"uid":"1_4","value":"b"}]'  # PREFER for forms!
mcporter call chrome-devtools.press_key key:"Enter"                         # key combo (Control+A, Escape, etc.)
mcporter call chrome-devtools.wait_for text:'["Success","Done"]'            # wait for text to appear
```

### JS Execution — extract data from page
```bash
mcporter call chrome-devtools.evaluate_script function:"() => { return document.title }"
mcporter call chrome-devtools.evaluate_script function:"() => { return Array.from(document.querySelectorAll('h2')).map(h=>h.textContent) }"
```

### Debug
```bash
mcporter call chrome-devtools.list_console_messages types:'["error","warn"]'
mcporter call chrome-devtools.list_network_requests resourceTypes:'["xhr","fetch"]'
```

## Other Useful Tools

| Tool | Use |
|------|-----|
| `emulate` | Device/network/geolocation/userAgent/colorScheme emulation |
| `handle_dialog` | Handle browser alert/confirm/prompt |
| `performance_start_trace` | Record performance trace (LCP/INP/CLS) |
| `lighthouse_audit` | Run accessibility/SEO/best-practices audit |

For remaining tools (`close_page`, `drag`, `hover`, `type_text`, `upload_file`, `resize_page`, `take_heapsnapshot`, `get_console_message`, `get_network_request`, `performance_stop_trace`, `performance_analyze_insight`), run:
```bash
mcporter list chrome-devtools --schema
```
