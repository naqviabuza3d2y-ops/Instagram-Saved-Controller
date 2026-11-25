# Changes and code cleanup

Treat requests to remove code bloat as behavior-preserving refactors unless the
user explicitly requests a behavior change. Fewer lines alone are not evidence
that a fallback or guard is unnecessary.

- Before removing a fallback, selector, timer, observer, or queue guard, identify
  the behavior it protects and its regression test. Add a missing behavior test
  before simplifying it; confirm the test fails when the protected behavior is
  removed.
- Keep regression fixtures representative of observed Instagram layouts. Do not
  narrow fixtures, weaken assertions, delete failing cases, or stub out the code
  being exercised merely to make a cleanup pass.
- Preserve automatic skipping of plain-text and heading error messages, HTTP
  200 error pages, creator-profile redirects, late error renders, and hidden
  preloads. Preserve confirmation delays and exclusions for real media,
  captions/comments, ordinary browsing, and Undo tabs.
- Run `node --test tests/*.test.mjs` before declaring a change verified. Report
  environmental failures separately from passing checks.
- When changing Instagram selectors, detection, or queue navigation, also verify
  the affected flow in the installed extension when a suitable live page is
  available. If unavailable, state that live verification remains outstanding.
- Keep cleanup and new behavior in separate changes where practical. Include
  preserved behavior and validation results in the handoff.
