#!/usr/bin/env node

import { createServer } from "node:http";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { execFile, execFileSync } from "node:child_process";

// OS keychain integration (required for PEM storage)
let keychainStore = null;
let keychainAvailable = null;
try {
  const keychain = await import("./keychain.mjs");
  keychainStore = keychain.keychainStore;
  keychainAvailable = keychain.keychainAvailable;
} catch {
  // Keychain module unavailable
}

const ROLE_DESCRIPTIONS = {
  lead: "Squad Lead — triage, architecture, project boards",
  frontend: "Squad Frontend — UI components, styling, client-side logic",
  backend: "Squad Backend — APIs, data models, server-side logic",
  tester: "Squad Tester — test plans, coverage, CI validation",
  security: "Squad Security — vulnerability scanning, policy enforcement",
  reviewer: "Squad Reviewer — code review, quality gates",
  codereview: "Squad Code Review — code review, quality gates",
  devops: "Squad DevOps — infrastructure, CI/CD, platform",
  docs: "Squad Docs — documentation, technical writing",
  data: "Squad Data — data engineering, analytics, database",
  ralph: "Squad Monitor — work queue, backlog monitoring",
  scribe: "Squad Scribe — documentation, ADRs, changelogs",
};

const ROLE_CONFIG = {
  lead: {
    description: ROLE_DESCRIPTIONS.lead,
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "write",
    },
  },
  frontend: {
    description: ROLE_DESCRIPTIONS.frontend,
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "write",
    },
  },
  backend: {
    description: ROLE_DESCRIPTIONS.backend,
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "write",
    },
  },
  tester: {
    description: ROLE_DESCRIPTIONS.tester,
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "write",
    },
  },
  security: {
    description: ROLE_DESCRIPTIONS.security,
    permissions: {
      contents: "read",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "read",
    },
  },
  reviewer: {
    description: ROLE_DESCRIPTIONS.reviewer,
    permissions: {
      contents: "read",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "read",
    },
  },
  codereview: {
    description: ROLE_DESCRIPTIONS.codereview,
    permissions: {
      contents: "read",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "read",
    },
  },
  devops: {
    description: ROLE_DESCRIPTIONS.devops,
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
      actions: "write",
      workflows: "write",
    },
  },
  docs: {
    description: ROLE_DESCRIPTIONS.docs,
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
    },
  },
  data: {
    description: ROLE_DESCRIPTIONS.data,
    permissions: {
      contents: "write",
      pull_requests: "write",
      issues: "write",
      checks: "read",
    },
  },
  ralph: {
    description: ROLE_DESCRIPTIONS.ralph,
    permissions: {
      contents: "read",
      pull_requests: "read",
      issues: "read",
      checks: "read",
      actions: "read",
    },
  },
  scribe: {
    description: ROLE_DESCRIPTIONS.scribe,
    permissions: {
      contents: "write",
      pull_requests: "read",
      issues: "read",
      workflows: "write",
    },
  },
};

const ROLE_ICONS = {
  lead: {
    color: "#2563EB",
    path: "M11 17.5C11 16.211 11.3752 15.0097 12.0223 13.9992H5.25278C4.01076 13.9992 3.00391 15.0061 3.00391 16.2481V17.1681C3.00391 17.7401 3.18231 18.298 3.51427 18.7639C5.05643 20.9282 7.5794 22.0004 11.0004 22.0004C11.6002 22.0004 12.1725 21.9674 12.7168 21.9014C11.6509 20.7436 11 19.1978 11 17.5ZM11.0004 2.00391C13.7618 2.00391 16.0004 4.24248 16.0004 7.00391C16.0004 9.76533 13.7618 12.0039 11.0004 12.0039C8.23894 12.0039 6.00036 9.76533 6.00036 7.00391C6.00036 4.24248 8.23894 2.00391 11.0004 2.00391ZM23 17.5C23 20.5376 20.5376 23 17.5 23C14.4624 23 12 20.5376 12 17.5C12 14.4624 14.4624 12 17.5 12C20.5376 12 23 14.4624 23 17.5ZM18.0554 14.4206C17.8806 13.8598 17.1194 13.8598 16.9446 14.4206L16.3876 16.2077H14.5851C14.0194 16.2077 13.7842 16.9623 14.2418 17.3089L15.7001 18.4134L15.1431 20.2004C14.9683 20.7612 15.584 21.2276 16.0417 20.881L17.5 19.7766L18.9583 20.881C19.416 21.2276 20.0317 20.7612 19.8569 20.2004L19.2999 18.4134L20.7582 17.3089C21.2158 16.9623 20.9806 16.2077 20.4149 16.2077H18.6124L18.0554 14.4206Z",
  },
  frontend: {
    color: "#7C3AED",
    path: "M12.5 2V5.25154C12.5 5.66576 12.8358 6.00154 13.25 6.00154C13.6642 6.00154 14 5.66576 14 5.25154V2H15V6.25112C15 6.66534 15.3358 7.00112 15.75 7.00112C16.1642 7.00112 16.5 6.66534 16.5 6.25112V2H18.2502C18.6645 2 19.0002 2.33579 19.0002 2.75V11H5.00024V2.75C5.00024 2.33579 5.33603 2 5.75024 2H12.5ZM5.00024 12.5V14.2521C5.00024 15.4947 6.0076 16.5021 7.25024 16.5021H9.99991V20C9.99991 21.1046 10.8953 22 11.9999 22C13.1045 22 13.9999 21.1046 13.9999 20V16.5021H16.7502C17.9929 16.5021 19.0002 15.4947 19.0002 14.2521V12.5H5.00024Z",
  },
  backend: {
    color: "#059669",
    path: "M9 2C7.34315 2 6 3.34315 6 5V19C6 20.6569 7.34315 22 9 22H15C16.6569 22 18 20.6569 18 19V5C18 3.34315 16.6569 2 15 2H9ZM8.5 6.75C8.5 6.33579 8.83579 6 9.25 6H14.75C15.1642 6 15.5 6.33579 15.5 6.75C15.5 7.16421 15.1642 7.5 14.75 7.5H9.25C8.83579 7.5 8.5 7.16421 8.5 6.75ZM8.5 17.75C8.5 17.3358 8.83579 17 9.25 17H14.75C15.1642 17 15.5 17.3358 15.5 17.75C15.5 18.1642 15.1642 18.5 14.75 18.5H9.25C8.83579 18.5 8.5 18.1642 8.5 17.75ZM8.5 14.75C8.5 14.3358 8.83579 14 9.25 14H14.75C15.1642 14 15.5 14.3358 15.5 14.75C15.5 15.1642 15.1642 15.5 14.75 15.5H9.25C8.83579 15.5 8.5 15.1642 8.5 14.75Z",
  },
  tester: {
    color: "#D97706",
    path: "M8.99998 4.5V10.7382C8.99998 11.1132 8.90628 11.4822 8.72739 11.8117L7.53944 14H16.4605L15.2726 11.8117C15.0937 11.4822 15 11.1132 15 10.7382V4.5H16C16.4142 4.5 16.75 4.16421 16.75 3.75C16.75 3.33579 16.4142 3 16 3H8C7.58579 3 7.25 3.33579 7.25 3.75C7.25 4.16421 7.58579 4.5 8 4.5H8.99998ZM17.2748 15.5H6.72515L5.14269 18.415C4.50968 19.5811 5.35388 20.9999 6.68068 20.9999H17.3193C18.6461 20.9999 19.4903 19.5811 18.8573 18.415L17.2748 15.5Z",
  },
  security: {
    color: "#DC2626",
    path: "M3 5.75C3 5.33579 3.33579 5 3.75 5C6.41341 5 9.00797 4.05652 11.55 2.15C11.8167 1.95 12.1833 1.95 12.45 2.15C14.992 4.05652 17.5866 5 20.25 5C20.6642 5 21 5.33579 21 5.75V11C21 11.3381 20.9865 11.6701 20.9595 11.9961C19.9577 11.3651 18.7715 11 17.5 11C13.9101 11 11 13.9101 11 17.5C11 19.151 11.6156 20.6583 12.6297 21.8048C12.5126 21.8531 12.3944 21.9007 12.2749 21.9478C12.0982 22.0174 11.9018 22.0174 11.7251 21.9478C5.95756 19.6757 3 16.0012 3 11V5.75ZM23 17.5C23 14.4624 20.5376 12 17.5 12C14.4624 12 12 14.4624 12 17.5C12 20.5376 14.4624 23 17.5 23C20.5376 23 23 20.5376 23 17.5ZM20.8536 15.1464C21.0488 15.3417 21.0488 15.6583 20.8536 15.8536L16.8536 19.8536C16.6583 20.0488 16.3417 20.0488 16.1464 19.8536L14.1464 17.8536C13.9512 17.6583 13.9512 17.3417 14.1464 17.1464C14.3417 16.9512 14.6583 16.9512 14.8536 17.1464L16.5 18.7929L20.1464 15.1464C20.3417 14.9512 20.6583 14.9512 20.8536 15.1464Z",
  },
  reviewer: {
    color: "#0891B2",
    path: "M3.49022 15.6482C3.44056 15.2822 3.12677 15 2.74707 15C2.36737 15 2.05358 15.2822 2.00392 15.6482L1.99707 15.75V19.2523L2.0025 19.4265C2.08889 20.8088 3.19641 21.9142 4.57955 21.9973L4.74707 22.0023H8.24707L8.34884 21.9955C8.71492 21.9458 8.99707 21.632 8.99707 21.2523C8.99707 20.8726 8.71492 20.5588 8.34884 20.5092L8.24707 20.5023H4.74707L4.61927 20.4959C4.03097 20.4361 3.56327 19.9684 3.50352 19.3801L3.49707 19.2523V15.75L3.49022 15.6482ZM21.9902 15.6482C21.9406 15.2822 21.6268 15 21.2471 15C20.8329 15 20.4971 15.3358 20.4971 15.75V19.2523L20.4906 19.3801C20.4266 20.0105 19.8943 20.5023 19.2471 20.5023H15.7471L15.6453 20.5092C15.2792 20.5588 14.9971 20.8726 14.9971 21.2523C14.9971 21.6665 15.3329 22.0023 15.7471 22.0023H19.2471L19.4146 21.9973C20.8554 21.9107 21.9971 20.7149 21.9971 19.2523V15.75L21.9902 15.6482ZM8.99707 2.75C8.99707 2.33579 8.66128 2 8.24707 2H4.74707L4.57955 2.00502C3.13877 2.0916 1.99707 3.28747 1.99707 4.75V8.25234L2.00392 8.35411C2.05358 8.72018 2.36737 9.00234 2.74707 9.00234C3.16128 9.00234 3.49707 8.66655 3.49707 8.25234V4.75L3.50352 4.62219C3.56754 3.99187 4.09986 3.5 4.74707 3.5H8.24707L8.34884 3.49315C8.71492 3.44349 8.99707 3.1297 8.99707 2.75ZM19.4146 2.00502L19.2471 2H15.7471L15.6453 2.00685C15.2792 2.05651 14.9971 2.3703 14.9971 2.75C14.9971 3.1297 15.2792 3.44349 15.6453 3.49315L15.7471 3.5H19.2471L19.3749 3.50645C19.9632 3.5662 20.4309 4.0339 20.4906 4.62219L20.4971 4.75V8.25234L20.5039 8.35411C20.5536 8.72018 20.8674 9.00234 21.2471 9.00234C21.6268 9.00234 21.9406 8.72018 21.9902 8.35411L21.9971 8.25234V4.75L21.9916 4.57583C21.9053 3.19357 20.7977 2.08813 19.4146 2.00502ZM8.5 13.5C8.5 11.567 10.067 10 12 10C13.933 10 15.5 11.567 15.5 13.5C15.5 15.433 13.933 17 12 17C10.067 17 8.5 15.433 8.5 13.5ZM6.21039 11.7435L6.202 11.764L6.2012 11.7662C6.05472 12.1521 5.62356 12.3473 5.23667 12.2022C4.63944 11.9783 4.79905 11.2333 4.80118 11.2277L4.80696 11.2129C4.8116 11.2011 4.81785 11.1856 4.82577 11.1666C4.84162 11.1286 4.86418 11.0765 4.89398 11.0123C4.95353 10.884 5.04233 10.7068 5.16468 10.4971C5.40882 10.0786 5.79018 9.52418 6.34469 8.96967C7.4652 7.84915 9.27433 6.75 12 6.75C14.7257 6.75 16.5348 7.84915 17.6553 8.96967C18.2099 9.52418 18.5912 10.0786 18.8354 10.4971C18.9577 10.7068 19.0465 10.884 19.1061 11.0123C19.1359 11.0765 19.1584 11.1286 19.1743 11.1666C19.1822 11.1856 19.1884 11.2011 19.1931 11.2129L19.1988 11.2277L19.2008 11.2329L19.2016 11.235L19.2023 11.2367C19.3477 11.6245 19.1512 12.0568 18.7634 12.2022C18.3769 12.3472 17.9472 12.1443 17.798 11.7642L17.7896 11.7435C17.7896 11.7435 17.7665 11.6891 17.7455 11.644C17.7035 11.5535 17.6361 11.4182 17.5397 11.2529C17.3463 10.9214 17.0402 10.4758 16.5947 10.0303C15.7152 9.15085 14.2743 8.25 12 8.25C9.7257 8.25 8.28483 9.15085 7.40535 10.0303C6.95985 10.4758 6.65371 10.9214 6.46035 11.2529C6.36395 11.4182 6.2965 11.5535 6.25449 11.644C6.23351 11.6891 6.21896 11.723 6.21039 11.7435Z",
  },
  codereview: {
    color: "#0891B2",
    path: "M3.49022 15.6482C3.44056 15.2822 3.12677 15 2.74707 15C2.36737 15 2.05358 15.2822 2.00392 15.6482L1.99707 15.75V19.2523L2.0025 19.4265C2.08889 20.8088 3.19641 21.9142 4.57955 21.9973L4.74707 22.0023H8.24707L8.34884 21.9955C8.71492 21.9458 8.99707 21.632 8.99707 21.2523C8.99707 20.8726 8.71492 20.5588 8.34884 20.5092L8.24707 20.5023H4.74707L4.61927 20.4959C4.03097 20.4361 3.56327 19.9684 3.50352 19.3801L3.49707 19.2523V15.75L3.49022 15.6482ZM21.9902 15.6482C21.9406 15.2822 21.6268 15 21.2471 15C20.8329 15 20.4971 15.3358 20.4971 15.75V19.2523L20.4906 19.3801C20.4266 20.0105 19.8943 20.5023 19.2471 20.5023H15.7471L15.6453 20.5092C15.2792 20.5588 14.9971 20.8726 14.9971 21.2523C14.9971 21.6665 15.3329 22.0023 15.7471 22.0023H19.2471L19.4146 21.9973C20.8554 21.9107 21.9971 20.7149 21.9971 19.2523V15.75L21.9902 15.6482ZM8.99707 2.75C8.99707 2.33579 8.66128 2 8.24707 2H4.74707L4.57955 2.00502C3.13877 2.0916 1.99707 3.28747 1.99707 4.75V8.25234L2.00392 8.35411C2.05358 8.72018 2.36737 9.00234 2.74707 9.00234C3.16128 9.00234 3.49707 8.66655 3.49707 8.25234V4.75L3.50352 4.62219C3.56754 3.99187 4.09986 3.5 4.74707 3.5H8.24707L8.34884 3.49315C8.71492 3.44349 8.99707 3.1297 8.99707 2.75ZM19.4146 2.00502L19.2471 2H15.7471L15.6453 2.00685C15.2792 2.05651 14.9971 2.3703 14.9971 2.75C14.9971 3.1297 15.2792 3.44349 15.6453 3.49315L15.7471 3.5H19.2471L19.3749 3.50645C19.9632 3.5662 20.4309 4.0339 20.4906 4.62219L20.4971 4.75V8.25234L20.5039 8.35411C20.5536 8.72018 20.8674 9.00234 21.2471 9.00234C21.6268 9.00234 21.9406 8.72018 21.9902 8.35411L21.9971 8.25234V4.75L21.9916 4.57583C21.9053 3.19357 20.7977 2.08813 19.4146 2.00502ZM8.5 13.5C8.5 11.567 10.067 10 12 10C13.933 10 15.5 11.567 15.5 13.5C15.5 15.433 13.933 17 12 17C10.067 17 8.5 15.433 8.5 13.5ZM6.21039 11.7435L6.202 11.764L6.2012 11.7662C6.05472 12.1521 5.62356 12.3473 5.23667 12.2022C4.63944 11.9783 4.79905 11.2333 4.80118 11.2277L4.80696 11.2129C4.8116 11.2011 4.81785 11.1856 4.82577 11.1666C4.84162 11.1286 4.86418 11.0765 4.89398 11.0123C4.95353 10.884 5.04233 10.7068 5.16468 10.4971C5.40882 10.0786 5.79018 9.52418 6.34469 8.96967C7.4652 7.84915 9.27433 6.75 12 6.75C14.7257 6.75 16.5348 7.84915 17.6553 8.96967C18.2099 9.52418 18.5912 10.0786 18.8354 10.4971C18.9577 10.7068 19.0465 10.884 19.1061 11.0123C19.1359 11.0765 19.1584 11.1286 19.1743 11.1666C19.1822 11.1856 19.1884 11.2011 19.1931 11.2129L19.1988 11.2277L19.2008 11.2329L19.2016 11.235L19.2023 11.2367C19.3477 11.6245 19.1512 12.0568 18.7634 12.2022C18.3769 12.3472 17.9472 12.1443 17.798 11.7642L17.7896 11.7435C17.7896 11.7435 17.7665 11.6891 17.7455 11.644C17.7035 11.5535 17.6361 11.4182 17.5397 11.2529C17.3463 10.9214 17.0402 10.4758 16.5947 10.0303C15.7152 9.15085 14.2743 8.25 12 8.25C9.7257 8.25 8.28483 9.15085 7.40535 10.0303C6.95985 10.4758 6.65371 10.9214 6.46035 11.2529C6.36395 11.4182 6.2965 11.5535 6.25449 11.644C6.23351 11.6891 6.21896 11.723 6.21039 11.7435Z",
  },
  devops: {
    color: "#8B5CF6",
    path: "M16.6928 2.31143C15.8128 2.11478 14.9147 2.01041 14.0131 2C13.0891 2.01065 12.19 2.11498 11.3089 2.31131C10.9245 2.39697 10.637 2.71797 10.5933 3.11011L10.3844 4.98787C10.3244 5.52521 10.0133 6.00258 9.54617 6.27409C9.07696 6.54875 8.50793 6.58162 8.01296 6.36398L6.29276 5.60685C5.93492 5.44935 5.51684 5.53522 5.24971 5.82108C4.00637 7.15157 3.08038 8.74728 2.54142 10.4881C2.42513 10.8638 2.55914 11.272 2.87529 11.5051L4.40162 12.6305C4.83721 12.9512 5.09414 13.4597 5.09414 14.0006C5.09414 14.5415 4.83721 15.05 4.40219 15.3703L2.8749 16.4976C2.55922 16.7307 2.42533 17.1383 2.54122 17.5136C3.07924 19.2561 4.00474 20.8536 5.24806 22.1858C5.51493 22.4718 5.93281 22.558 6.29071 22.4009L8.01859 21.6424C8.51117 21.4269 9.07783 21.4585 9.54452 21.728C10.0112 21.9976 10.3225 22.473 10.3834 23.0093L10.5908 24.8855C10.6336 25.2729 10.9148 25.5917 11.2933 25.6819C13.0725 26.106 14.9263 26.106 16.7055 25.6819C17.084 25.5917 17.3651 25.2729 17.408 24.8855L17.6157 23.0065C17.675 22.4692 17.9858 21.9923 18.4529 21.7219C18.92 21.4514 19.4876 21.4197 19.9818 21.6364L21.7093 22.3947C22.0671 22.5518 22.4849 22.4657 22.7517 22.1799C23.9944 20.8491 24.9198 19.2536 25.4586 17.513C25.5748 17.1376 25.441 16.7296 25.1251 16.4964L23.5988 15.3697C23.1628 15.0488 22.9059 14.5402 22.9059 13.9994C22.9059 13.4585 23.1628 12.9499 23.5978 12.6297L25.1228 11.5034C25.4386 11.2702 25.5723 10.8623 25.4561 10.4869C24.9172 8.74605 23.9912 7.15034 22.7478 5.81984C22.4807 5.53399 22.0626 5.44812 21.7048 5.60562L19.9843 6.36288C19.769 6.45832 19.5385 6.50694 19.3055 6.50657C18.4387 6.50566 17.7116 5.85214 17.617 4.98931L17.4079 3.11011C17.3643 2.71817 17.077 2.39728 16.6928 2.31143ZM14 18C11.7909 18 10 16.2091 10 14C10 11.7909 11.7909 10 14 10C16.2091 10 18 11.7909 18 14C18 16.2091 16.2091 18 14 18Z",
  },
  docs: {
    color: "#EC4899",
    scale: 11,
    translateX: 72,
    translateY: 58,
    path: "M14 2V10C14 11.1046 14.8954 12 16 12H23.9989C23.9996 12.0261 24 12.0522 24 12.0784V23.6C24 24.9255 22.9255 26 21.6 26H6.4C5.07452 26 4 24.9255 4 23.6V4.4C4 3.07452 5.07452 2 6.4 2H14ZM15.5 2.47509V10C15.5 10.2761 15.7239 10.5 16 10.5H23.5019C23.4109 10.3701 23.3082 10.2475 23.1945 10.1339L15.7636 2.70294C15.6809 2.62022 15.5927 2.54415 15.5 2.47509Z",
  },
  data: {
    color: "#6366F1",
    path: "M12 10C16.4183 10 20 8.20914 20 6C20 3.79086 16.4183 2 12 2C7.58172 2 4 3.79086 4 6C4 8.20914 7.58172 10 12 10ZM18.3277 10.1701C18.9156 9.87611 19.4979 9.50399 20 9.05337V18C20 20.2091 16.4183 22 12 22C7.58172 22 4 20.2091 4 18V9.05337C4.50211 9.50399 5.08441 9.87611 5.67233 10.1701C7.36922 11.0185 9.60849 11.5 12 11.5C14.3915 11.5 16.6308 11.0185 18.3277 10.1701Z",
  },
  ralph: {
    color: "#10B981",
    path: "M16.0518 5.0285C15.7169 5.46765 15.8014 6.09515 16.2405 6.43007C17.9675 7.74714 19 9.78703 19 12C19 15.4973 16.4352 18.3956 13.084 18.9166L13.7929 18.2071C14.1834 17.8166 14.1834 17.1834 13.7929 16.7929C13.4024 16.4024 12.7692 16.4024 12.3787 16.7929L9.87868 19.2929C9.48816 19.6834 9.48816 20.3166 9.87868 20.7071L12.3787 23.2071C12.7692 23.5976 13.4024 23.5976 13.7929 23.2071C14.1834 22.8166 14.1834 22.1834 13.7929 21.7929L12.9497 20.9505C17.4739 20.476 21 16.6498 21 12C21 9.15644 19.6712 6.53122 17.4533 4.83978C17.0142 4.50486 16.3867 4.58936 16.0518 5.0285ZM14.1213 3.29289L11.6213 0.792893C11.2308 0.402369 10.5976 0.402369 10.2071 0.792893C9.84662 1.15338 9.81889 1.72061 10.1239 2.1129L10.2071 2.20711L11.0503 3.04951C6.52615 3.52399 3 7.35021 3 12C3 14.7198 4.21515 17.2432 6.2716 18.9419C6.6974 19.2936 7.32771 19.2335 7.67943 18.8077C8.03116 18.3819 7.97111 17.7516 7.54531 17.3999C5.94404 16.0772 5 14.1168 5 12C5 8.50269 7.56475 5.60441 10.916 5.08343L10.2071 5.79289C9.81658 6.18342 9.81658 6.81658 10.2071 7.20711C10.5676 7.56759 11.1348 7.59532 11.5271 7.2903L11.6213 7.20711L14.1213 4.70711C14.4818 4.34662 14.5095 3.77939 14.2045 3.3871L14.1213 3.29289Z",
  },
  scribe: {
    color: "#6B7280",
    path: "M16.25 2C16.6642 2 17 2.33579 17 2.75V4H17.75C18.9926 4 20 5.00736 20 6.25V16H16.25C15.0074 16 14 17.0074 14 18.25V22H6.25C5.00736 22 4 20.9926 4 19.75V6.25C4 5.00736 5.00736 4 6.25 4H7V2.75C7 2.33579 7.33579 2 7.75 2C8.16421 2 8.5 2.33579 8.5 2.75V4H11.25V2.75C11.25 2.33579 11.5858 2 12 2C12.4142 2 12.75 2.33579 12.75 2.75V4H15.5V2.75C15.5 2.33579 15.8358 2 16.25 2ZM19.7607 17.5C19.7032 17.5894 19.6369 17.6737 19.5605 17.75L15.75 21.5605C15.6737 21.6369 15.5894 21.7032 15.5 21.7607V18.25C15.5 17.8358 15.8358 17.5 16.25 17.5H19.7607ZM8.25 16C7.83579 16 7.5 16.3358 7.5 16.75C7.5 17.1642 7.83579 17.5 8.25 17.5H11.25L11.3271 17.4961C11.7051 17.4575 12 17.1382 12 16.75C12 16.3618 11.7051 16.0425 11.3271 16.0039L11.25 16H8.25ZM8.25 12C7.83579 12 7.5 12.3358 7.5 12.75C7.5 13.1642 7.83579 13.5 8.25 13.5H15.75C16.1642 13.5 16.5 13.1642 16.5 12.75C16.5 12.3358 16.1642 12 15.75 12H8.25ZM8.25 8C7.83579 8 7.5 8.33579 7.5 8.75C7.5 9.16421 7.83579 9.5 8.25 9.5H15.75C16.1642 9.5 16.5 9.16421 16.5 8.75C16.5 8.33579 16.1642 8 15.75 8H8.25Z",
  },
};

const SPARKLE_PATH = "M10.0606 18.7011C10.3353 18.8955 10.6636 19.0001 11.0002 19.0003C11.3164 19.0002 11.6258 18.9079 11.8904 18.7348C12.155 18.5616 12.3634 18.3151 12.4902 18.0253L13.2592 15.6853C13.4468 15.1224 13.7629 14.6108 14.1824 14.1912C14.6019 13.7715 15.1133 13.4552 15.6762 13.2673L17.9142 12.5403C18.2319 12.429 18.5068 12.2209 18.7002 11.9453C18.8489 11.7359 18.9457 11.4942 18.9826 11.24C19.0195 10.9859 18.9956 10.7266 18.9127 10.4836C18.8298 10.2405 18.6903 10.0206 18.5057 9.842C18.3212 9.66341 18.0968 9.53122 17.8512 9.45633L15.6362 8.73633C15.073 8.54959 14.5611 8.23421 14.141 7.81519C13.721 7.39617 13.4043 6.88503 13.2162 6.32233L12.4892 4.08533C12.3773 3.76844 12.1697 3.49414 11.8952 3.30033C11.6189 3.10983 11.2913 3.00781 10.9557 3.00781C10.6201 3.00781 10.2924 3.10983 10.0162 3.30033C9.73716 3.4974 9.52724 3.77729 9.41618 4.10033L8.67918 6.36533C8.49149 6.91331 8.18155 7.41139 7.77284 7.82184C7.36413 8.23228 6.86736 8.54433 6.32018 8.73433L4.08018 9.46133C3.76144 9.574 3.48574 9.78322 3.29145 10.0599C3.09716 10.3365 2.99393 10.6669 2.99613 11.0049C2.99833 11.343 3.10585 11.672 3.30372 11.9461C3.5016 12.2202 3.78 12.4258 4.10018 12.5343L6.31618 13.2533C6.8811 13.4423 7.39454 13.7596 7.81618 14.1803C7.92914 14.2934 8.0347 14.4137 8.13218 14.5403C8.39803 14.8828 8.60301 15.2684 8.73818 15.6803L9.46618 17.9143C9.57824 18.2317 9.78592 18.5066 10.0606 18.7011ZM19.8043 24.7815C20.0078 24.9248 20.2509 25.0013 20.4999 25.0003C20.7473 25.0014 20.989 24.926 21.1919 24.7843C21.4002 24.6365 21.5563 24.4264 21.6379 24.1843L22.0099 23.0413C22.0885 22.804 22.2214 22.5883 22.3979 22.4113C22.5745 22.2342 22.7898 22.1007 23.0269 22.0213L24.1929 21.6433C24.4284 21.5597 24.6324 21.4053 24.7769 21.2013C24.9218 20.998 24.9997 20.7545 24.9997 20.5048C24.9997 20.2551 24.9218 20.0117 24.7769 19.8083C24.6232 19.5961 24.4056 19.4387 24.1559 19.3593L23.0119 18.9883C22.7746 18.9097 22.5588 18.7768 22.3818 18.6003C22.2047 18.4237 22.0712 18.2084 21.9919 17.9713L21.6129 16.8083C21.5311 16.5706 21.3768 16.3646 21.1717 16.2193C20.9666 16.074 20.721 15.9967 20.4696 15.9985C20.2182 16.0003 19.9738 16.0809 19.7707 16.2291C19.5676 16.3773 19.4162 16.5855 19.3379 16.8243L18.9639 17.9703C18.8873 18.2046 18.7579 18.4181 18.5858 18.5944C18.4136 18.7708 18.2032 18.9052 17.9709 18.9873L16.8049 19.3653C16.5693 19.449 16.3653 19.6034 16.2209 19.8073C16.0759 20.0107 15.998 20.2542 15.998 20.5038C15.998 20.7535 16.0759 20.997 16.2209 21.2003C16.3695 21.407 16.5794 21.5617 16.8209 21.6423L17.9649 22.0143C18.2032 22.0932 18.4196 22.2268 18.5969 22.4045C18.7743 22.5822 18.9075 22.7989 18.9859 23.0373L19.3639 24.2003C19.4468 24.4351 19.6008 24.6381 19.8043 24.7815Z";

const HELP_TEXT = `Usage: squad-identity rotate-key --role <role> --pem <path>
       OR use the squad_identity_rotate_key tool in Copilot CLI

Standalone: node create-app.mjs --role <role> [--owner <github-username>] [--prefix <app-name-prefix>]

Options:
  --role <role>      Required. One of: ${Object.keys(ROLE_CONFIG).join(", ")}
  --name <name>      Override the generated app name (default: {prefix}-squad-{role})
  --owner <owner>    GitHub username used for the app homepage URL (default: gh api user --jq .login)
  --prefix <prefix>  App name prefix (default: squad)
  --icon             Show a generated avatar preview + PNG download on success
  --icon-only        Skip app creation and only open the generated icon preview
  --generate-key     Open the existing app settings page so you can generate a private key manually
  --import-key <path>
                     Import a downloaded PEM into the OS keychain
  --help, -h         Show this help message

Private keys are stored in the OS keychain (macOS Keychain / Linux libsecret).
No PEM files are written to the filesystem.`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const values = { prefix: "squad" };
  const valueFlags = new Set(["--role", "--owner", "--prefix", "--import-key", "--name"]);

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];

    if (arg === "--help" || arg === "-h") {
      values.help = true;
      continue;
    }

    if (arg === "--icon") {
      values.icon = true;
      continue;
    }

    if (arg === "--icon-only") {
      values.iconOnly = true;
      continue;
    }

    if (arg === "--generate-key") {
      values.generateKey = true;
      continue;
    }

    if (!arg.startsWith("--")) {
      fail(`Unknown argument: ${arg}`);
    }

    const [flag, inlineValue] = arg.split("=", 2);
    if (!valueFlags.has(flag)) {
      fail(`Unknown argument: ${flag}`);
    }

    const value = inlineValue ?? argv[index + 1];
    if (!value || value.startsWith("--")) {
      fail(`Missing value for ${flag}`);
    }

    if (inlineValue === undefined) {
      index += 1;
    }

    if (flag === "--role") values.role = value;
    if (flag === "--owner") values.owner = value;
    if (flag === "--prefix") values.prefix = value;
    if (flag === "--import-key") values.importKey = value;
    if (flag === "--name") values.name = value;
  }

  return values;
}

function ensureGhAvailable() {
  try {
    execFileSync("gh", ["--version"], { stdio: "ignore" });
  } catch {
    fail('GitHub CLI "gh" is required but was not found in PATH.');
  }
}

function getDefaultOwner() {
  try {
    return execFileSync("gh", ["api", "user", "--jq", ".login"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  } catch (error) {
    fail(`Unable to determine --owner from gh: ${formatCommandError(error)}`);
  }
}

function findProjectRoot(startDir) {
  let currentDir = resolve(startDir);

  while (true) {
    if (existsSync(join(currentDir, ".squad"))) {
      return currentDir;
    }

    const parentDir = dirname(currentDir);
    if (parentDir === currentDir) {
      fail('Could not find repository root containing ".squad". Run this from the repo.');
    }

    currentDir = parentDir;
  }
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function openBrowser(url) {
  const platform = process.platform;
  let bin;
  let args;

  if (platform === "darwin") {
    bin = "open";
    args = [url];
  } else if (platform === "win32") {
    bin = "cmd.exe";
    args = ["/c", "start", "", url];
  } else {
    bin = "xdg-open";
    args = [url];
  }

  execFile(bin, args, (error) => {
    if (error) {
      console.log(`Could not open the browser automatically.`);
      console.log(`Open this URL manually: ${url}`);
    }
  });
}

function buildManifest(appName, owner, manifestRedirectUrl, oauthCallbackUrl, permissions, description) {
  return {
    name: appName,
    url: `https://github.com/${owner}`,
    description,
    // Manifest gotchas:
    // - Do NOT include metadata: "read" — GitHub returns "resource not included".
    // - Do NOT use projects — organization boards use organization_projects.
    // - public MUST be true — false triggers "Public cannot be private".
    // - workflows: "read" is invalid and GitHub silently drops all permissions.
    // - callback_url must exactly match the OAuth redirect URI used later.
    redirect_url: manifestRedirectUrl,
    callback_url: oauthCallbackUrl,
    public: true,
    default_permissions: { ...permissions },
    default_events: [],
  };
}

function expandHomePath(pathValue) {
  if (!pathValue) return pathValue;
  if (pathValue === "~") {
    return process.env.HOME ?? process.env.USERPROFILE ?? pathValue;
  }

  if (pathValue.startsWith("~/") || pathValue.startsWith("~\\")) {
    const homeDir = process.env.HOME ?? process.env.USERPROFILE;
    if (!homeDir) {
      fail("Cannot expand ~ in --keys-dir because HOME is not set.");
    }
    return resolve(homeDir, pathValue.slice(2));
  }

  return pathValue;
}

function getRoleIconSvg(role) {
  const icon = ROLE_ICONS[role];
  if (!icon) {
    return null;
  }

  const glyphScale = icon.scale ?? 12.5;
  const glyphX = icon.translateX ?? 82;
  const glyphY = icon.translateY ?? 66;

  return `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512" role="img" aria-label="${role} app icon">
  <rect width="512" height="512" fill="${icon.color}"/>
  <g transform="translate(${glyphX} ${glyphY}) scale(${glyphScale})" fill="#FFFFFF">
    <path d="${icon.path}"/>
  </g>
  <g transform="translate(334 334) scale(5)" fill="#FFFFFF">
    <path d="${SPARKLE_PATH}"/>
  </g>
</svg>`;
}

function getRoleBadgeColor(role) {
  return ROLE_ICONS[role]?.color ?? null;
}

function renderCompletionPage(appData) {
  const iconScript = appData.iconSvg
    ? `
    const iconSvg = ${JSON.stringify(appData.iconSvg)};
    const svgBlob = new Blob([iconSvg], { type: "image/svg+xml" });
    const svgUrl = URL.createObjectURL(svgBlob);
    const image = new Image();
    image.onload = () => {
      const canvas = document.getElementById("icon-canvas");
      const context = canvas.getContext("2d");
      context.clearRect(0, 0, canvas.width, canvas.height);
      context.drawImage(image, 0, 0, canvas.width, canvas.height);
      const pngUrl = canvas.toDataURL("image/png");
      document.getElementById("icon-preview").src = pngUrl;
      const download = document.getElementById("download-icon");
      download.href = pngUrl;
      download.download = ${JSON.stringify(`${appData.role}.png`)};
      download.hidden = false;
      document.getElementById("icon-card").hidden = false;
      URL.revokeObjectURL(svgUrl);
    };
    image.src = svgUrl;
    `
    : "";

  const iconSection = appData.iconSvg
    ? `
    <section class="card" id="icon-card" hidden>
      <h2>Suggested avatar</h2>
      <img id="icon-preview" alt="Generated app avatar preview" width="192" height="192" />
      <canvas id="icon-canvas" width="512" height="512" hidden></canvas>
      ${appData.badgeColor ? `<p><strong>Badge background color:</strong> <code>${escapeHtml(appData.badgeColor)}</code></p>` : ""}
      ${appData.settingsUrl ? `<p><strong>Update app settings:</strong> <a href="${escapeHtml(appData.settingsUrl)}" target="_blank" rel="noreferrer">${escapeHtml(appData.settingsUrl)}</a></p>` : ""}
      <p>${appData.appUrl
        ? `Download this PNG and upload it as your app avatar at <a href="${escapeHtml(appData.appUrl)}" target="_blank" rel="noreferrer">${escapeHtml(appData.appUrl)}</a>.`
        : "Download this PNG and use it as your app avatar."}</p>
      <p><a id="download-icon" class="button" hidden>Download PNG</a></p>
    </section>
    `
    : "";

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>GitHub App Created</title>
    <style>
      body {
        font-family: system-ui, sans-serif;
        background: #0f172a;
        color: #e2e8f0;
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        padding: 24px;
      }
      .stack {
        width: min(560px, 100%);
        display: grid;
        gap: 16px;
      }
      .card {
        background: #111827;
        border: 1px solid #334155;
        border-radius: 16px;
        padding: 24px;
        box-shadow: 0 10px 30px rgba(0, 0, 0, 0.25);
      }
      h1, h2, p { margin: 0 0 12px; }
      a { color: #93c5fd; }
      .button {
        display: inline-block;
        padding: 10px 16px;
        border-radius: 10px;
        background: #2563eb;
        color: white;
        text-decoration: none;
        font-weight: 600;
      }
      img {
        display: block;
        width: 192px;
        height: 192px;
        border-radius: 24px;
        background: #1e293b;
        margin-bottom: 12px;
      }
      .muted { color: #94a3b8; }
      code {
        display: inline-block;
        padding: 2px 8px;
        border-radius: 8px;
        background: #1e293b;
        color: #f8fafc;
        font-family: ui-monospace, SFMono-Regular, monospace;
      }
    </style>
  </head>
  <body>
    <div class="stack">
      <section class="card">
        <h1>${escapeHtml(appData.heading ?? "✅ GitHub App created")}</h1>
        <p>${appData.slug ? `Your app <strong>${escapeHtml(appData.slug)}</strong> is ready.` : escapeHtml(appData.message ?? "")}</p>
        ${appData.appUrl ? `<p><a href="${escapeHtml(appData.appUrl)}" target="_blank" rel="noreferrer">${escapeHtml(appData.appUrl)}</a></p>` : ""}
        <p class="muted">${escapeHtml(appData.footer ?? "You can close this tab and return to the terminal.")}</p>
      </section>
      ${iconSection}
    </div>
    <script>${iconScript}</script>
  </body>
</html>`;
}

function serveIconOnlyPreview(role, slug) {
  return new Promise((resolvePromise, rejectPromise) => {
    const iconSvg = getRoleIconSvg(role);
    if (!iconSvg) {
      rejectPromise(new Error(`No icon is configured for role "${role}".`));
      return;
    }

    let served = false;
    let timeoutHandle;
    let shutdownHandle;

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      if (requestUrl.pathname !== "/") {
        response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
        response.end("Not found");
        return;
      }

      response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      response.end(
        renderCompletionPage({
          badgeColor: getRoleBadgeColor(role),
          heading: `Icon generated for role: ${role}`,
          message: "Download the PNG from this page.",
          footer: "Close this tab when you're done.",
          iconSvg,
          settingsUrl: `https://github.com/settings/apps/${slug}`,
          role,
        }),
      );

      if (!served) {
        served = true;
        clearTimeout(timeoutHandle);
        shutdownHandle = setTimeout(() => {
          server.close();
          resolvePromise();
        }, 30 * 1000);
      }
    });

    server.on("error", (error) => {
      clearTimeout(timeoutHandle);
      clearTimeout(shutdownHandle);
      rejectPromise(error);
    });

    timeoutHandle = setTimeout(() => {
      server.close();
      rejectPromise(new Error("Timed out waiting for the icon preview page to be opened."));
    }, 5 * 60 * 1000);

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        clearTimeout(timeoutHandle);
        rejectPromise(new Error("Failed to start the icon preview server."));
        return;
      }

      const localUrl = `http://localhost:${address.port}`;
      console.log(`Opening browser: ${localUrl}`);
      openBrowser(localUrl);
    });
  });
}

function loadIdentityConfig(projectRoot) {
  const configPath = join(projectRoot, ".squad", "identity", "config.json");
  try {
    return JSON.parse(readFileSync(configPath, "utf8"));
  } catch {
    return null;
  }
}

function getAppSlugForRole(projectRoot, role) {
  const config = loadIdentityConfig(projectRoot);
  const appEntry = config?.apps?.[role];
  const appSlug = appEntry?.appSlug ?? appEntry?.slug;
  if (!appSlug) {
    fail(`No appSlug found for role "${role}" in .squad/identity/config.json.`);
  }
  return appSlug;
}

function saveIdentityConfig(projectRoot, config) {
  const identityDir = join(projectRoot, ".squad", "identity");
  const configPath = join(identityDir, "config.json");
  mkdirSync(identityDir, { recursive: true });
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

function waitForManifestCode(manifestTemplate) {
  return new Promise((resolvePromise, rejectPromise) => {
    let settled = false;
    let codeResolved = false;
    let completionData = null;
    let shutdownHandle;

    const settle = (callback) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeoutHandle);
      clearTimeout(shutdownHandle);
      server.close();
      callback();
    };

    const server = createServer((request, response) => {
      const requestUrl = new URL(request.url ?? "/", "http://localhost");
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      const manifestRedirectUrl = `http://localhost:${port}`;
      const oauthCallbackUrl = `http://localhost:${port}/callback`;

      if (requestUrl.pathname === "/" && !requestUrl.searchParams.has("code")) {
        const manifest = {
          ...manifestTemplate,
          redirect_url: manifestRedirectUrl,
          callback_url: oauthCallbackUrl,
        };
        const manifestJson = JSON.stringify(manifest);

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(`<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Create GitHub App</title>
  </head>
  <body>
    <h1>Creating GitHub App…</h1>
    <p>If the form does not submit automatically, use the button below.</p>
    <form id="manifest-form" action="https://github.com/settings/apps/new" method="post">
      <input type="hidden" name="manifest" value="${escapeHtml(manifestJson)}">
      <button type="submit">Continue to GitHub</button>
    </form>
    <script>document.getElementById("manifest-form").submit();</script>
  </body>
</html>`);
        return;
      }

      const code = requestUrl.searchParams.get("code");
      if (requestUrl.pathname === "/" && code) {
        if (!codeResolved) {
          codeResolved = true;
          clearTimeout(timeoutHandle);
          resolvePromise({
            code,
            callbackUrl: oauthCallbackUrl,
            port,
            complete(data) {
              completionData = data;
              clearTimeout(shutdownHandle);
              shutdownHandle = setTimeout(() => {
                server.close();
              }, 2 * 60 * 1000);
            },
          });
        }

        response.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
        response.end(completionData
          ? renderCompletionPage(completionData)
          : `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8">
    <title>Finalizing GitHub App</title>
    <style>
      body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; display: grid; place-items: center; min-height: 100vh; margin: 0; }
      .card { background: #111827; border: 1px solid #334155; border-radius: 16px; padding: 24px; max-width: 480px; }
    </style>
  </head>
  <body>
    <div class="card">
      <h1>Finishing app setup…</h1>
      <p>Keep this tab open while the terminal saves your credentials.</p>
      <script>
        const refresh = async () => {
          const result = await fetch("/result", { cache: "no-store" });
          const data = await result.json();
          if (data.ready) {
            location.reload();
            return;
          }
          setTimeout(refresh, 1000);
        };
        refresh();
      </script>
    </div>
  </body>
</html>`);
        return;
      }

      if (requestUrl.pathname === "/result") {
        response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
        response.end(JSON.stringify({ ready: Boolean(completionData) }));
        return;
      }

      response.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" });
      response.end("Not found");
    });

    const timeoutHandle = setTimeout(() => {
      settle(() => rejectPromise(new Error("Timed out waiting for the GitHub callback after 5 minutes.")));
    }, 5 * 60 * 1000);

    server.on("error", (error) => {
      settle(() => rejectPromise(error));
    });

    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        settle(() => rejectPromise(new Error("Failed to start the local callback server.")));
        return;
      }

      const localUrl = `http://localhost:${address.port}`;
      console.log(`Opening browser: ${localUrl}`);
      console.log("Waiting for GitHub App creation...");
      openBrowser(localUrl);
    });
  });
}

async function exchangeManifestCode(code) {
  try {
    const output = execFileSync("gh", ["api", "-X", "POST", `app-manifests/${code}/conversions`], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
    return JSON.parse(output);
  } catch {
    // Fall back to fetch if gh has network/auth trouble.
  }

  const response = await fetch(`https://api.github.com/app-manifests/${code}/conversions`, {
    method: "POST",
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`GitHub API error ${response.status}: ${body}`);
  }

  return response.json();
}

function saveCredentials(projectRoot, role, appData) {
  const appsDir = join(projectRoot, ".squad", "identity", "apps");
  const appPath = join(appsDir, `${role}.json`);

  mkdirSync(appsDir, { recursive: true });

  // Save app registration (safe to version — no secrets)
  writeFileSync(
    appPath,
    `${JSON.stringify(
      {
        appId: appData.id,
        slug: appData.slug,
        clientId: appData.client_id,
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  // Store PEM in OS keychain (required — no filesystem fallback)
  if (!keychainStore || !keychainAvailable || !keychainAvailable()) {
    fail(
      "OS keychain is not available on this system.\n" +
      "PEM private keys are stored exclusively in the OS keychain.\n\n" +
      "To fix this:\n" +
      "  macOS: Keychain Access is built-in (the 'security' command should work)\n" +
      "  Linux: Install libsecret — apt install libsecret-tools (Ubuntu/Debian)\n" +
      "         or dnf install libsecret (Fedora/RHEL)\n" +
      "  CI/CD: Use sync-secrets.mjs to upload credentials as GitHub repo secrets,\n" +
      "         then set SQUAD_{ROLE}_PRIVATE_KEY as an environment variable.\n\n" +
      "The app registration has been saved to:\n" +
      `  ${appPath}\n` +
      "But the private key could NOT be stored. You will need to re-create this app\n" +
      "on a system with keychain support."
    );
  }

  const stored = keychainStore(appData.id, appData.pem);
  if (!stored) {
    fail(
      `Failed to store private key in OS keychain for app ${appData.id}.\n` +
      "Check that your keychain is unlocked and accessible.\n" +
      `The app registration has been saved to: ${appPath}\n` +
      "But the private key could NOT be stored."
    );
  }

  // Store OAuth credentials in keychain too (as a separate entry)
  if (appData.client_secret) {
    try {
      keychainStore(`${appData.id}-oauth`, JSON.stringify({
        clientId: appData.client_id,
        clientSecret: appData.client_secret,
        callbackUrl: appData.callback_url,
      }));
    } catch {
      // OAuth secret storage is best-effort
    }
  }

  return { appPath };
}

function assertPemLooksValid(pemContent, sourcePath) {
  if (!pemContent.startsWith("-----BEGIN RSA PRIVATE KEY-----")) {
    fail(`Imported key at ${sourcePath} is not an RSA private key PEM.`);
  }
}

function importPrivateKey(importPathArg, role, projectRoot) {
  const sourcePath = resolve(expandHomePath(importPathArg));
  if (!existsSync(sourcePath)) {
    fail(`Private key file not found: ${sourcePath}`);
  }

  const stat = lstatSync(sourcePath);
  if (!stat.isFile()) {
    fail(`Private key path must be a file: ${sourcePath}`);
  }

  const pemContent = readFileSync(sourcePath, "utf8");
  assertPemLooksValid(pemContent, sourcePath);

  // Look up the app ID for this role
  const appsDir = join(projectRoot, ".squad", "identity", "apps");
  const appPath = join(appsDir, `${role}.json`);
  if (!existsSync(appPath)) {
    fail(`No app registration found for role "${role}" at ${appPath}. Create the app first.`);
  }

  let appData;
  try {
    appData = JSON.parse(readFileSync(appPath, "utf8"));
  } catch {
    fail(`Failed to parse app registration at ${appPath}.`);
  }

  if (!appData.appId) {
    fail(`App registration at ${appPath} is missing "appId".`);
  }

  if (!keychainStore || !keychainAvailable || !keychainAvailable()) {
    fail(
      "OS keychain is not available on this system.\n" +
      "PEM private keys are stored exclusively in the OS keychain.\n\n" +
      "To fix this:\n" +
      "  macOS: Keychain Access is built-in (the 'security' command should work)\n" +
      "  Linux: Install libsecret — apt install libsecret-tools (Ubuntu/Debian)\n" +
      "         or dnf install libsecret (Fedora/RHEL)"
    );
  }

  const stored = keychainStore(appData.appId, pemContent);
  if (!stored) {
    fail(`Failed to store private key in OS keychain for app ${appData.appId}.`);
  }

  return appData.appId;
}

function formatCommandError(error) {
  if (!error || typeof error !== "object") {
    return String(error);
  }

  const stderr = typeof error.stderr === "string" ? error.stderr.trim() : "";
  const stdout = typeof error.stdout === "string" ? error.stdout.trim() : "";
  return stderr || stdout || error.message || "command failed";
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    console.log(HELP_TEXT);
    return;
  }

  if (!args.role) {
    fail(`--role is required.\n\n${HELP_TEXT}`);
  }

  if (!Object.prototype.hasOwnProperty.call(ROLE_CONFIG, args.role)) {
    fail(`Invalid --role "${args.role}". Expected one of: ${Object.keys(ROLE_CONFIG).join(", ")}`);
  }

  const specialModes = [args.iconOnly, args.generateKey, Boolean(args.importKey)].filter(Boolean).length;
  if (specialModes > 1) {
    fail("Use only one of --icon-only, --generate-key, or --import-key at a time.");
  }

  if (args.iconOnly) {
    const previewSlug = `${args.prefix ?? "squad"}-${args.role}`;
    await serveIconOnlyPreview(args.role, previewSlug);
    console.log(`Icon generated for role: ${args.role}. Download the PNG from the browser.`);
    return;
  }

  const projectRoot = findProjectRoot(process.cwd());

  if (args.generateKey && !args.owner) {
    fail("--owner is required with --generate-key.");
  }

  if (args.generateKey) {
    const appSlug = getAppSlugForRole(projectRoot, args.role);
    const settingsUrl = `https://github.com/settings/apps/${appSlug}`;

    console.log(`Opening browser: ${settingsUrl}`);
    openBrowser(settingsUrl);
    console.log("Go to the app settings page and click 'Generate a private key'.");
    console.log(
      `Then run: squad-identity rotate-key --role ${args.role} --pem ~/Downloads/${appSlug}*.pem`,
    );
    return;
  }

  const owner = args.owner ?? getDefaultOwner();

  if (args.importKey) {
    const appId = importPrivateKey(args.importKey, args.role, projectRoot);
    console.log(`🔐 Imported private key for role "${args.role}" into OS keychain (app-${appId}).`);
    console.log(`You can now delete the PEM file at: ${resolve(expandHomePath(args.importKey))}`);
    return;
  }

  ensureGhAvailable();

  const prefix = args.prefix ?? "squad";
  const roleConfig = ROLE_CONFIG[args.role];
  const appName = args.name ?? `${prefix}-${args.role}`;

  console.log(`Creating ${appName} for ${owner}...`);

  const manifest = buildManifest(
    appName,
    owner,
    "http://localhost:0",
    "http://localhost:0/callback",
    roleConfig.permissions,
    roleConfig.description,
  );

  const { code, callbackUrl, complete } = await waitForManifestCode(manifest);
  console.log("Received manifest callback. Exchanging code...");

  const appData = await exchangeManifestCode(code);
  appData.callback_url = callbackUrl;
  for (const field of ["id", "slug", "pem", "client_id", "client_secret"]) {
    if (!appData[field]) {
      fail(`GitHub returned an incomplete app registration; missing "${field}".`);
    }
  }

  const { appPath } = saveCredentials(projectRoot, args.role, appData);
  const appUrl = `https://github.com/settings/apps/${appData.slug}`;
  const iconSvg = args.icon ? getRoleIconSvg(args.role) : null;

  complete({
    appUrl,
    badgeColor: getRoleBadgeColor(args.role),
    iconSvg,
    role: args.role,
    settingsUrl: `https://github.com/settings/apps/${appData.slug}`,
    slug: appData.slug,
  });

  console.log(`Created ${appName}.`);
  console.log(`App URL: ${appUrl}`);
  console.log(`🔐 Private key stored in OS keychain (app-${appData.id}).`);
  console.log(`Registration: ${appPath}`);
  if (args.icon) {
    console.log(`Avatar preview: open the browser tab and download the PNG for upload at ${appUrl}`);
  }
}

main().catch((error) => {
  fail(error instanceof Error ? error.message : String(error));
});
