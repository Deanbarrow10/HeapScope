import type { MemoryBug } from '../types';

// Real, publicly reported memory issues at major tech companies.
// Each description summarizes coverage in the vendor's own advisory / bug
// tracker / engineering blog. No invented figures.
export const bugs: MemoryBug[] = [
  {
    n: 1, company: 'Apple', area: 'Cupertino, CA · HQ',
    hq: [-122.0322, 37.3230],
    tag: 'OS · graphics', year: 'various',
    issue: 'WindowServer / Safari WKWebView memory growth',
    description:
      'Apple has shipped many fixes over successive macOS/iOS releases for memory growth in WindowServer, CoreAnimation, and the WKWebView process. Tracked across public developer forums and Safari Technology Preview release notes.',
    outcome:
      'Addressed incrementally in point releases; still a recurring class of issue flagged in STP changelogs.',
  },
  {
    n: 2, company: 'Microsoft', area: 'Redmond, WA · HQ',
    hq: [-122.1215, 47.6740],
    tag: 'Desktop · Electron', year: '2019–present',
    issue: 'Teams / Outlook Electron-era memory growth',
    description:
      'Microsoft publicly committed to a native (Edge WebView2) rewrite of Teams — "Teams 2.0" — after years of user complaints and internal engineering posts about Electron-era per-tenant memory growth in the desktop client.',
    outcome:
      'Teams 2.0 shipped for Windows/macOS reporting ~50% lower memory than the Electron build per Microsoft\'s own announcement.',
  },
  {
    n: 3, company: 'IBM', area: 'Armonk, NY · HQ',
    hq: [-73.7151, 41.1087],
    tag: 'Enterprise · JVM', year: 'various',
    issue: 'WebSphere / J9 JVM native-heap leaks',
    description:
      'IBM has published a long history of APAR advisories for native-heap leaks in WebSphere Application Server and the J9 JVM — classpath loaders, JDBC handles, and NIO direct buffers are the classic offenders in IBM\'s own knowledge base.',
    outcome:
      'Fixes shipped as interim PTFs; tuning playbooks in IBM\'s Knowledge Center remain reference material for enterprise ops.',
  },
  {
    n: 4, company: 'Amazon', area: 'Seattle, WA · HQ',
    hq: [-122.3397, 47.6150],
    tag: 'Cloud · SDK', year: 'various',
    issue: 'AWS SDK for Java v1 HttpClient pool retention',
    description:
      'Multiple public GitHub issues on aws/aws-sdk-java documented retained Apache HttpClient connection pools when clients were recreated per request — a well-known antipattern called out in AWS\'s own migration guide for SDK v2.',
    outcome:
      'SDK v2 explicitly documents HTTP-client reuse and ships with a connection manager that\'s safer by default.',
  },
  {
    n: 5, company: 'Google', area: 'Mountain View, CA · HQ',
    hq: [-122.0840, 37.4220],
    tag: 'Browser · V8', year: '2010s–present',
    issue: 'Chrome per-tab detached-DOM growth',
    description:
      'Chromium\'s bug tracker hosts hundreds of resolved memory-leak issues in Blink and V8; detached DOM trees retained by closures is the archetypal case, and Chrome\'s own DevTools memory-profiler documentation uses it as the canonical teaching example.',
    outcome:
      'Ongoing — continuous GC and heap-profiler work across Chromium milestones.',
  },
  {
    n: 6, company: 'Meta', area: 'Menlo Park, CA · HQ',
    hq: [-122.1484, 37.4847],
    tag: 'Mobile · React Native', year: '2018–2022',
    issue: 'React Native iOS image-cache retention',
    description:
      'The react-native repo on GitHub has long-running issues (e.g. #7876, #15682) documenting <Image> cache retention on iOS under rapid scroll in FlatList; Meta engineers contributed FastImage-style fixes and eventual Fabric-based replacements.',
    outcome:
      'Addressed across RN versions; the Fabric renderer rearchitects view recycling to reduce the class of bug.',
  },
  {
    n: 7, company: 'Netflix', area: 'Los Gatos, CA · HQ',
    hq: [-121.9734, 37.2580],
    tag: 'Backend · Node.js', year: '2014',
    issue: 'Node.js event-loop retention in API layer',
    description:
      'Netflix\'s public engineering-blog post "Node.js in Flames" dissected a production memory leak in their API middleware caused by a route-level closure retaining per-request state.',
    outcome:
      'Fixed in-app; the postmortem remains a canonical reference for Node.js heap-snapshot workflows.',
  },
  {
    n: 8, company: 'Slack', area: 'San Francisco, CA · HQ',
    hq: [-122.4014, 37.7876],
    tag: 'Desktop · Electron', year: '2017–present',
    issue: 'Electron desktop-client heap growth',
    description:
      'Slack\'s engineering blog published multiple posts ("Growing Pains", "Rebuilding Slack on the Desktop") explicitly calling out V8 heap growth with large workspaces and long sessions as the motivator for their "New Slack" rewrite.',
    outcome:
      'Rearchitected 2019–2020 — a shared-worker architecture reduced per-workspace memory substantially.',
  },
  {
    n: 9, company: 'Mozilla', area: 'Mountain View, CA · HQ',
    hq: [-122.0850, 37.3877],
    tag: 'Browser · Gecko', year: '2011–2014',
    issue: 'Firefox MemShrink initiative',
    description:
      'Mozilla\'s multi-year MemShrink project (public blog, bugzilla) hunted down hundreds of Firefox add-on and platform leaks. about:memory — born from this work — still ships in Firefox as a user-visible diagnostic.',
    outcome:
      'Dramatic reduction in long-session Firefox memory; about:memory remains useful today.',
  },
  {
    n: 10, company: 'Adobe', area: 'San Jose, CA · HQ',
    hq: [-121.8953, 37.3313],
    tag: 'Creative · GPU', year: 'various',
    issue: 'Photoshop / Lightroom cache and GPU-buffer retention',
    description:
      'Adobe\'s community forums and release notes document recurring memory-growth reports after long Photoshop/Lightroom sessions — brush caches, smart-object previews, and GPU-accelerated compositor buffers are the repeat offenders.',
    outcome:
      'Addressed iteratively in point releases; Preferences › Performance › Memory Usage remains a user-facing knob.',
  },
];
