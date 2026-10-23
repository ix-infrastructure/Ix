// Copyright 2026 Ix Infrastructure Inc.

/**
 * What `ix impact` printed for the graph in impact-json-locations.test.ts
 * before its JSON rows carried path/lineStart/lineEnd and containers gained
 * dependentList: the json, llm and text output, the exit code, and how many
 * requests each json run made. Captured from the command, not written by hand.
 */
export const BASELINE = {
  "json": {
    "leaf": {
      "resolvedTarget": {
        "kind": "function",
        "name": "verify"
      },
      "depth": 1,
      "systemPath": [
        {
          "name": "App",
          "kind": "system"
        },
        {
          "name": "Auth Layer",
          "kind": "subsystem"
        }
      ],
      "riskSummary": "Medium risk — widely shared dependency affecting the auth layer layer.",
      "riskLevel": "medium",
      "riskCategory": "shared",
      "atRiskBehavior": [
        "Multiple callers across different subsystems",
        "Downstream operations coordinated by this component",
        "Cross-module behavior consistency"
      ],
      "summary": {
        "callers": 5,
        "callees": 1
      },
      "callerList": [
        {
          "kind": "method",
          "name": "login"
        },
        {
          "kind": "function",
          "name": "handle"
        },
        {
          "kind": "file",
          "name": "main.ts"
        },
        {
          "kind": "function",
          "name": "orphan"
        },
        {
          "name": "lazy"
        }
      ],
      "calleeList": [
        {
          "kind": "function",
          "name": "decode_jwt"
        }
      ],
      "propagationBuckets": [
        {
          "region": "Auth Layer",
          "regionKind": "subsystem",
          "count": 4,
          "members": [
            {
              "name": "login",
              "kind": "method"
            },
            {
              "name": "handle",
              "kind": "function"
            },
            {
              "name": "main.ts",
              "kind": "file"
            },
            {
              "name": "lazy",
              "kind": "function"
            }
          ]
        },
        {
          "region": "Core",
          "regionKind": "module",
          "count": 1,
          "members": [
            {
              "name": "orphan",
              "kind": "function"
            }
          ]
        }
      ],
      "decisions": [
        {
          "id": "dec1",
          "name": "Use JWT"
        }
      ]
    },
    "file": {
      "resolvedTarget": {
        "kind": "file",
        "name": "auth.ts"
      },
      "depth": 1,
      "riskSummary": "Low risk to dependent code.",
      "riskLevel": "low",
      "riskCategory": "unknown",
      "atRiskBehavior": [
        "Dependent code behavior"
      ],
      "summary": {
        "members": 2,
        "directImporters": 2,
        "directDependents": 2,
        "memberLevelCallers": 3
      },
      "topImpactedMembers": [
        {
          "name": "verify",
          "kind": "function",
          "id": "m1",
          "callerCount": 2,
          "path": "src/auth.ts",
          "lineStart": 1,
          "lineEnd": 20
        },
        {
          "name": "Session",
          "kind": "class",
          "id": "m2",
          "callerCount": 1,
          "path": "src/auth.ts",
          "lineStart": 22,
          "lineEnd": 80
        }
      ],
      "propagationBuckets": [
        {
          "region": "Auth Layer",
          "regionKind": "subsystem",
          "count": 2,
          "members": [
            {
              "name": "app.ts",
              "kind": "file"
            },
            {
              "name": "boot",
              "kind": "function"
            }
          ]
        },
        {
          "region": "Core",
          "regionKind": "module",
          "count": 1,
          "members": [
            {
              "name": "handle",
              "kind": "method"
            }
          ]
        }
      ],
      "tasks": [
        {
          "id": "task1",
          "name": "Rotate keys",
          "status": "open"
        }
      ]
    },
    "class": {
      "resolvedTarget": {
        "kind": "class",
        "name": "Session"
      },
      "depth": 1,
      "riskSummary": "Low risk to dependent code.",
      "riskLevel": "low",
      "riskCategory": "unknown",
      "atRiskBehavior": [
        "Dependent code behavior"
      ],
      "summary": {
        "members": 1,
        "directImporters": 1,
        "directDependents": 3,
        "memberLevelCallers": 1
      },
      "topImpactedMembers": [
        {
          "name": "Session",
          "kind": "class",
          "id": "m2",
          "callerCount": 1,
          "path": "src/auth.ts",
          "lineStart": 22,
          "lineEnd": 80
        }
      ],
      "propagationBuckets": [
        {
          "region": "Auth Layer",
          "regionKind": "subsystem",
          "count": 1,
          "members": [
            {
              "name": "boot",
              "kind": "function"
            }
          ]
        },
        {
          "region": "Core",
          "regionKind": "module",
          "count": 2,
          "members": [
            {
              "name": "handle",
              "kind": "method"
            },
            {
              "name": "nowhere",
              "kind": "function"
            }
          ]
        }
      ]
    },
    "all": {
      "target": "target",
      "resolutionMode": "all",
      "candidates": [
        {
          "n": 1,
          "id": "t-verify",
          "name": "verify",
          "kind": "function",
          "path": "src/auth.ts"
        },
        {
          "n": 2,
          "id": "t-class",
          "name": "Session",
          "kind": "class",
          "path": "src/session.ts"
        }
      ],
      "results": [
        {
          "candidate": 1,
          "resolvedTarget": {
            "kind": "function",
            "name": "verify"
          },
          "depth": 1,
          "systemPath": [
            {
              "name": "App",
              "kind": "system"
            },
            {
              "name": "Auth Layer",
              "kind": "subsystem"
            }
          ],
          "riskSummary": "Medium risk — widely shared dependency affecting the auth layer layer.",
          "riskLevel": "medium",
          "riskCategory": "shared",
          "atRiskBehavior": [
            "Multiple callers across different subsystems",
            "Downstream operations coordinated by this component",
            "Cross-module behavior consistency"
          ],
          "summary": {
            "callers": 5,
            "callees": 1
          },
          "callerList": [
            {
              "kind": "method",
              "name": "login"
            },
            {
              "kind": "function",
              "name": "handle"
            },
            {
              "kind": "file",
              "name": "main.ts"
            },
            {
              "kind": "function",
              "name": "orphan"
            },
            {
              "name": "lazy"
            }
          ],
          "calleeList": [
            {
              "kind": "function",
              "name": "decode_jwt"
            }
          ],
          "propagationBuckets": [
            {
              "region": "Auth Layer",
              "regionKind": "subsystem",
              "count": 4,
              "members": [
                {
                  "name": "login",
                  "kind": "method"
                },
                {
                  "name": "handle",
                  "kind": "function"
                },
                {
                  "name": "main.ts",
                  "kind": "file"
                },
                {
                  "name": "lazy",
                  "kind": "function"
                }
              ]
            },
            {
              "region": "Core",
              "regionKind": "module",
              "count": 1,
              "members": [
                {
                  "name": "orphan",
                  "kind": "function"
                }
              ]
            }
          ],
          "decisions": [
            {
              "id": "dec1",
              "name": "Use JWT"
            }
          ]
        },
        {
          "candidate": 2,
          "resolvedTarget": {
            "kind": "class",
            "name": "Session"
          },
          "depth": 1,
          "riskSummary": "Low risk to dependent code.",
          "riskLevel": "low",
          "riskCategory": "unknown",
          "atRiskBehavior": [
            "Dependent code behavior"
          ],
          "summary": {
            "members": 1,
            "directImporters": 1,
            "directDependents": 3,
            "memberLevelCallers": 1
          },
          "topImpactedMembers": [
            {
              "name": "Session",
              "kind": "class",
              "id": "m2",
              "callerCount": 1,
              "path": "src/auth.ts",
              "lineStart": 22,
              "lineEnd": 80
            }
          ],
          "propagationBuckets": [
            {
              "region": "Auth Layer",
              "regionKind": "subsystem",
              "count": 1,
              "members": [
                {
                  "name": "boot",
                  "kind": "function"
                }
              ]
            },
            {
              "region": "Core",
              "regionKind": "module",
              "count": 2,
              "members": [
                {
                  "name": "handle",
                  "kind": "method"
                },
                {
                  "name": "nowhere",
                  "kind": "function"
                }
              ]
            }
          ]
        }
      ]
    }
  },
  "llm": {
    "leaf": "impact target=verify kind=function risk=medium category=shared system_path=\"App,Auth Layer\" summary=\"Medium risk — widely shared dependency affecting the auth layer layer.\"\nbehavior text=\"Multiple callers across different subsystems\"\nbehavior text=\"Downstream operations coordinated by this component\"\nbehavior text=\"Cross-module behavior consistency\"\ncounts callers=5 callees=1 shown_callers=5 shown_callees=1\nbucket region=\"auth layer layer\" kind=subsystem count=4\nbucket region=\"core layer\" kind=module count=1\ncaller name=login kind=method path=src/auth/login.ts lines=10-42\ncaller name=handle kind=function path=src/http/handle.ts\ncaller name=main.ts kind=file path=src/main.ts\ncaller name=orphan kind=function\ncaller name=lazy\ncallee name=decode_jwt kind=function path=src/jwt.ts lines=3-9\ndecision name=\"Use JWT\"",
    "file": "impact target=auth.ts kind=file risk=low category=unknown summary=\"Low risk to dependent code.\"\nbehavior text=\"Dependent code behavior\"\ncounts members=2 importers=2 dependents=2 member_callers=3\nbucket region=\"auth layer layer\" kind=subsystem count=2\nbucket region=\"core layer\" kind=module count=1\nmember name=verify kind=function callers=2 path=src/auth.ts lines=1-20\nmember name=Session kind=class callers=1 path=src/auth.ts lines=22-80\ntask name=\"Rotate keys\" status=open",
    "class": "impact target=Session kind=class risk=low category=unknown summary=\"Low risk to dependent code.\"\nbehavior text=\"Dependent code behavior\"\ncounts members=1 importers=1 dependents=3 member_callers=1\nbucket region=\"core layer\" kind=module count=2\nbucket region=\"auth layer layer\" kind=subsystem count=1\nmember name=Session kind=class callers=1 path=src/auth.ts lines=22-80",
    "all": "impact_all target=target candidates=2 total=2\ncandidate n=1 name=verify kind=function path=src/auth.ts id=t-verify\nimpact target=verify kind=function risk=medium category=shared system_path=\"App,Auth Layer\" summary=\"Medium risk — widely shared dependency affecting the auth layer layer.\"\nbehavior text=\"Multiple callers across different subsystems\"\nbehavior text=\"Downstream operations coordinated by this component\"\nbehavior text=\"Cross-module behavior consistency\"\ncounts callers=5 callees=1 shown_callers=5 shown_callees=1\nbucket region=\"auth layer layer\" kind=subsystem count=4\nbucket region=\"core layer\" kind=module count=1\ncaller name=login kind=method path=src/auth/login.ts lines=10-42\ncaller name=handle kind=function path=src/http/handle.ts\ncaller name=main.ts kind=file path=src/main.ts\ncaller name=orphan kind=function\ncaller name=lazy\ncallee name=decode_jwt kind=function path=src/jwt.ts lines=3-9\ndecision name=\"Use JWT\"\ncandidate n=2 name=Session kind=class path=src/session.ts id=t-class\nimpact target=Session kind=class risk=low category=unknown summary=\"Low risk to dependent code.\"\nbehavior text=\"Dependent code behavior\"\ncounts members=1 importers=1 dependents=3 member_callers=1\nbucket region=\"core layer\" kind=module count=2\nbucket region=\"auth layer layer\" kind=subsystem count=1\nmember name=Session kind=class callers=1 path=src/auth.ts lines=22-80"
  },
  "text": {
    "leaf": "Resolved: function verify\n\n  System path:      App > Auth Layer\n\nRisk summary\n  Medium risk — widely shared dependency affecting the auth layer layer.\n\nAt-risk behavior\n  • Multiple callers across different subsystems\n  • Downstream operations coordinated by this component\n  • Cross-module behavior consistency\n\nPropagation\n  auth layer layer               4 dependents\n  core layer                     1 dependents\n\nMost affected\n  • callers across multiple subsystems\n  • Callers: login, handle and 3 more\n\nSupporting context\n  Direct callers:   5\n  Direct callees:   1\n\nCalls\n  function   decode_jwt\n\nDecisions\n  Use JWT",
    "file": "Resolved: file auth.ts\n\n\nRisk summary\n  Low risk to dependent code.\n\nAt-risk behavior\n  • Dependent code behavior\n\nPropagation\n  auth layer layer               2 dependents\n  core layer                     1 dependents\n\nMost affected\n  • verify, Session in the container\n\nSupporting context\n  Members:          2\n  Importers:        2\n  Direct dependents:2\n  Member-level callers:3\n\nTasks\n  ○ [open] Rotate keys",
    "class": "Resolved: class Session\n\n\nRisk summary\n  Low risk to dependent code.\n\nAt-risk behavior\n  • Dependent code behavior\n\nPropagation\n  core layer                     2 dependents\n  auth layer layer               1 dependents\n\nMost affected\n  • Session in the container\n\nSupporting context\n  Members:          1\n  Importers:        1\n  Direct dependents:3\n  Member-level callers:1",
    "all": "── [1] function verify in src/auth.ts ──\nResolved: function verify\n\n  System path:      App > Auth Layer\n\nRisk summary\n  Medium risk — widely shared dependency affecting the auth layer layer.\n\nAt-risk behavior\n  • Multiple callers across different subsystems\n  • Downstream operations coordinated by this component\n  • Cross-module behavior consistency\n\nPropagation\n  auth layer layer               4 dependents\n  core layer                     1 dependents\n\nMost affected\n  • callers across multiple subsystems\n  • Callers: login, handle and 3 more\n\nSupporting context\n  Direct callers:   5\n  Direct callees:   1\n\nCalls\n  function   decode_jwt\n\nDecisions\n  Use JWT\n\n── [2] class Session in src/session.ts ──\nResolved: class Session\n\n\nRisk summary\n  Low risk to dependent code.\n\nAt-risk behavior\n  • Dependent code behavior\n\nPropagation\n  core layer                     2 dependents\n  auth layer layer               1 dependents\n\nMost affected\n  • Session in the container\n\nSupporting context\n  Members:          1\n  Importers:        1\n  Direct dependents:3\n  Member-level callers:1"
  },
  "exitCode": {
    "leaf": {
      "json": null,
      "llm": null,
      "text": null
    },
    "file": {
      "json": null,
      "llm": null,
      "text": null
    },
    "class": {
      "json": null,
      "llm": null,
      "text": null
    },
    "all": {
      "json": null,
      "llm": null,
      "text": null
    }
  },
  "requests": {
    "leaf": {
      "expand": 11,
      "entity": 1
    },
    "file": {
      "expand": 12,
      "entity": 0
    },
    "class": {
      "expand": 11,
      "entity": 0
    },
    "all": {
      "expand": 22,
      "entity": 1
    }
  }
} as const;
