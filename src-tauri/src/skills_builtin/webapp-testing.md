---
name: webapp-testing
description: "Test a local web app end to end — start it, open it in a browser, click through flows, check console and network errors, take screenshots."
---
# Steps
1. Start the app's dev server with run_command in the background; read its output for the URL and port; wait until it is ready.
2. Drive a browser:
   - If the Browser (Playwright) or Chrome DevTools plugin is installed, use its tools: navigate, snapshot the page, click, type, take screenshots, read console and network.
   - Otherwise write a small Playwright script (`npx playwright` / `pip install playwright`) and run it.
3. For each flow: act like a user, then check the visible result, the console (no errors), and failed network requests.
4. Check responsive sizes (e.g. 375px and 1280px) and basic keyboard navigation for UI work.
5. Report what works, what fails (with the error text and steps to reproduce), and screenshots of problems. Stop the background dev server if you started it and the user does not need it.
