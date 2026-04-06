import type { PluginCapabilitySpec } from "@contextvm/elo";
import type { Expr, PluginDiagnostic } from "@contextvm/elo";

import type {
  RelatrCapabilityArgValidator,
  RelatrCapabilityDefinition,
} from "./types.js";

function diagnostic(message: string): PluginDiagnostic {
  return {
    severity: "error",
    message,
  };
}

function isObjectExpr(expr: Expr): expr is Extract<Expr, { type: "object" }> {
  return expr.type === "object";
}

function getObjectPropertyMap(
  expr: Extract<Expr, { type: "object" }>,
): Map<string, Expr> {
  return new Map(
    expr.properties.map((property) => [property.key, property.value]),
  );
}

function validateObjectShape(
  capabilityName: string,
  argsExpr: Expr,
  options: {
    requiredKeys?: string[];
    optionalKeys?: string[];
    allowExtraKeys?: boolean;
  } = {},
): PluginDiagnostic[] {
  if (!isObjectExpr(argsExpr)) {
    return [
      diagnostic(`${capabilityName} requires an object literal argument`),
    ];
  }

  const diagnostics: PluginDiagnostic[] = [];
  const properties = getObjectPropertyMap(argsExpr);
  const requiredKeys = options.requiredKeys ?? [];
  const optionalKeys = options.optionalKeys ?? [];
  const allowedKeys = new Set([...requiredKeys, ...optionalKeys]);

  for (const key of requiredKeys) {
    if (!properties.has(key)) {
      diagnostics.push(
        diagnostic(
          `${capabilityName} requires a '${key}' field in the arguments object`,
        ),
      );
    }
  }

  if (!options.allowExtraKeys) {
    for (const key of properties.keys()) {
      if (!allowedKeys.has(key)) {
        diagnostics.push(
          diagnostic(
            `${capabilityName} does not support an '${key}' field in the arguments object`,
          ),
        );
      }
    }
  }

  return diagnostics;
}

function validateStringField(
  capabilityName: string,
  argsExpr: Expr,
  fieldName: string,
): PluginDiagnostic[] {
  if (!isObjectExpr(argsExpr)) {
    return [
      diagnostic(`${capabilityName} requires an object literal argument`),
    ];
  }

  const value = getObjectPropertyMap(argsExpr).get(fieldName);
  if (!value) {
    return [];
  }

  if (value.type === "string") {
    if (value.value.trim().length === 0) {
      return [diagnostic(`${capabilityName}.${fieldName} must not be empty`)];
    }

    return [];
  }

  const definitelyNonStringLiteralTypes: Expr["type"][] = [
    "literal",
    "null",
    "object",
    "array",
  ];

  if (definitelyNonStringLiteralTypes.includes(value.type)) {
    return [
      diagnostic(
        `${capabilityName}.${fieldName} must be a string literal when provided`,
      ),
    ];
  }

  return [];
}

function validateNonNegativeNumberField(
  capabilityName: string,
  argsExpr: Expr,
  fieldName: string,
): PluginDiagnostic[] {
  if (!isObjectExpr(argsExpr)) {
    return [
      diagnostic(`${capabilityName} requires an object literal argument`),
    ];
  }

  const value = getObjectPropertyMap(argsExpr).get(fieldName);
  if (!value) {
    return [];
  }

  const numericLiteral =
    value.type === "literal" && typeof value.value === "number"
      ? value.value
      : value.type === "unary" &&
          value.operator === "-" &&
          value.operand.type === "literal" &&
          typeof value.operand.value === "number"
        ? -value.operand.value
        : null;

  if (numericLiteral === null) {
    return [
      diagnostic(
        `${capabilityName}.${fieldName} must be a numeric literal when provided`,
      ),
    ];
  }

  if (!Number.isFinite(numericLiteral) || numericLiteral < 0) {
    return [
      diagnostic(
        `${capabilityName}.${fieldName} must be a non-negative number`,
      ),
    ];
  }

  return [];
}

function createCapabilitySpec(
  name: string,
  validateArgs?: RelatrCapabilityArgValidator,
): PluginCapabilitySpec {
  return validateArgs ? { name, validateArgs } : { name };
}

const RELATR_CAPABILITY_NAME_ENTRIES = [
  ["nostrQuery", "nostr.query"],
  ["graphStats", "graph.stats"],
  ["graphAllPubkeys", "graph.all_pubkeys"],
  ["graphPubkeyExists", "graph.pubkey_exists"],
  ["graphIsFollowing", "graph.is_following"],
  ["graphAreMutual", "graph.are_mutual"],
  ["graphDistanceFromRoot", "graph.distance_from_root"],
  ["graphDistanceBetween", "graph.distance_between"],
  ["graphUsersWithinDistance", "graph.users_within_distance"],
  ["graphDegree", "graph.degree"],
  ["graphDegreeHistogram", "graph.degree_histogram"],
  ["httpNip05Resolve", "http.nip05_resolve"],
] as const;

export const RELATR_CAPABILITIES = Object.freeze(
  Object.fromEntries(RELATR_CAPABILITY_NAME_ENTRIES),
) as {
  readonly [K in (typeof RELATR_CAPABILITY_NAME_ENTRIES)[number][0]]: Extract<
    (typeof RELATR_CAPABILITY_NAME_ENTRIES)[number],
    readonly [K, string]
  >[1];
};

export const RELATR_CAPABILITY_DEFINITIONS: RelatrCapabilityDefinition[] = [
  {
    name: RELATR_CAPABILITIES.nostrQuery,
    description: "Query Nostr relays for events with a filter",
    argRule: {
      description:
        "Accepts a Nostr filter object. Any filter keys are allowed.",
      example: { kinds: [1], authors: ["npub..."], limit: 50 },
    },
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(RELATR_CAPABILITIES.nostrQuery),
  },
  {
    name: RELATR_CAPABILITIES.graphStats,
    description: "Get comprehensive graph statistics",
    argRule: {
      description: "Takes an empty object.",
      example: {},
    },
    validateArgs: ({ argsExpr }) =>
      validateObjectShape(RELATR_CAPABILITIES.graphStats, argsExpr, {
        requiredKeys: [],
        optionalKeys: [],
      }),
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(RELATR_CAPABILITIES.graphStats, ({ argsExpr }) =>
        validateObjectShape(RELATR_CAPABILITIES.graphStats, argsExpr, {
          requiredKeys: [],
          optionalKeys: [],
        }),
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphAllPubkeys,
    description: "Get all unique pubkeys in the social graph",
    argRule: {
      description: "Takes an empty object.",
      example: {},
    },
    validateArgs: ({ argsExpr }) =>
      validateObjectShape(RELATR_CAPABILITIES.graphAllPubkeys, argsExpr, {
        requiredKeys: [],
        optionalKeys: [],
      }),
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphAllPubkeys,
        ({ argsExpr }) =>
          validateObjectShape(RELATR_CAPABILITIES.graphAllPubkeys, argsExpr, {
            requiredKeys: [],
            optionalKeys: [],
          }),
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphPubkeyExists,
    description: "Check if a pubkey exists in the graph",
    argRule: {
      requiredKeys: ["pubkey"],
      description: "Requires a pubkey field.",
      example: { pubkey: "hex-pubkey" },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(RELATR_CAPABILITIES.graphPubkeyExists, argsExpr, {
        requiredKeys: ["pubkey"],
        optionalKeys: [],
      }),
      ...validateStringField(
        RELATR_CAPABILITIES.graphPubkeyExists,
        argsExpr,
        "pubkey",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphPubkeyExists,
        ({ argsExpr }) => [
          ...validateObjectShape(
            RELATR_CAPABILITIES.graphPubkeyExists,
            argsExpr,
            {
              requiredKeys: ["pubkey"],
              optionalKeys: [],
            },
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphPubkeyExists,
            argsExpr,
            "pubkey",
          ),
        ],
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphIsFollowing,
    description: "Check if a direct follow relationship exists",
    argRule: {
      requiredKeys: ["followerPubkey", "followedPubkey"],
      description: "Requires followerPubkey and followedPubkey fields.",
      example: {
        followerPubkey: "hex-pubkey-a",
        followedPubkey: "hex-pubkey-b",
      },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(RELATR_CAPABILITIES.graphIsFollowing, argsExpr, {
        requiredKeys: ["followerPubkey", "followedPubkey"],
        optionalKeys: [],
      }),
      ...validateStringField(
        RELATR_CAPABILITIES.graphIsFollowing,
        argsExpr,
        "followerPubkey",
      ),
      ...validateStringField(
        RELATR_CAPABILITIES.graphIsFollowing,
        argsExpr,
        "followedPubkey",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphIsFollowing,
        ({ argsExpr }) => [
          ...validateObjectShape(
            RELATR_CAPABILITIES.graphIsFollowing,
            argsExpr,
            {
              requiredKeys: ["followerPubkey", "followedPubkey"],
              optionalKeys: [],
            },
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphIsFollowing,
            argsExpr,
            "followerPubkey",
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphIsFollowing,
            argsExpr,
            "followedPubkey",
          ),
        ],
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphAreMutual,
    description: "Check if two pubkeys mutually follow each other",
    argRule: {
      requiredKeys: ["a", "b"],
      description: "Requires a and b pubkey fields.",
      example: { a: "hex-pubkey-a", b: "hex-pubkey-b" },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(RELATR_CAPABILITIES.graphAreMutual, argsExpr, {
        requiredKeys: ["a", "b"],
        optionalKeys: [],
      }),
      ...validateStringField(RELATR_CAPABILITIES.graphAreMutual, argsExpr, "a"),
      ...validateStringField(RELATR_CAPABILITIES.graphAreMutual, argsExpr, "b"),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphAreMutual,
        ({ argsExpr }) => [
          ...validateObjectShape(RELATR_CAPABILITIES.graphAreMutual, argsExpr, {
            requiredKeys: ["a", "b"],
            optionalKeys: [],
          }),
          ...validateStringField(
            RELATR_CAPABILITIES.graphAreMutual,
            argsExpr,
            "a",
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphAreMutual,
            argsExpr,
            "b",
          ),
        ],
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphDistanceFromRoot,
    description: "Get the hop distance from the current graph root to a pubkey",
    argRule: {
      requiredKeys: ["pubkey"],
      description: "Requires a pubkey field.",
      example: { pubkey: "hex-pubkey" },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(
        RELATR_CAPABILITIES.graphDistanceFromRoot,
        argsExpr,
        {
          requiredKeys: ["pubkey"],
          optionalKeys: [],
        },
      ),
      ...validateStringField(
        RELATR_CAPABILITIES.graphDistanceFromRoot,
        argsExpr,
        "pubkey",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphDistanceFromRoot,
        ({ argsExpr }) => [
          ...validateObjectShape(
            RELATR_CAPABILITIES.graphDistanceFromRoot,
            argsExpr,
            {
              requiredKeys: ["pubkey"],
              optionalKeys: [],
            },
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphDistanceFromRoot,
            argsExpr,
            "pubkey",
          ),
        ],
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphDistanceBetween,
    description: "Get the hop distance between two pubkeys",
    argRule: {
      requiredKeys: ["sourcePubkey", "targetPubkey"],
      description: "Requires sourcePubkey and targetPubkey fields.",
      example: {
        sourcePubkey: "hex-pubkey-a",
        targetPubkey: "hex-pubkey-b",
      },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(
        RELATR_CAPABILITIES.graphDistanceBetween,
        argsExpr,
        {
          requiredKeys: ["sourcePubkey", "targetPubkey"],
          optionalKeys: [],
        },
      ),
      ...validateStringField(
        RELATR_CAPABILITIES.graphDistanceBetween,
        argsExpr,
        "sourcePubkey",
      ),
      ...validateStringField(
        RELATR_CAPABILITIES.graphDistanceBetween,
        argsExpr,
        "targetPubkey",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphDistanceBetween,
        ({ argsExpr }) => [
          ...validateObjectShape(
            RELATR_CAPABILITIES.graphDistanceBetween,
            argsExpr,
            {
              requiredKeys: ["sourcePubkey", "targetPubkey"],
              optionalKeys: [],
            },
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphDistanceBetween,
            argsExpr,
            "sourcePubkey",
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphDistanceBetween,
            argsExpr,
            "targetPubkey",
          ),
        ],
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphUsersWithinDistance,
    description:
      "Get all pubkeys reachable within a given hop distance from the current root",
    argRule: {
      requiredKeys: ["distance"],
      description: "Requires a non-negative numeric distance field.",
      example: { distance: 2 },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(
        RELATR_CAPABILITIES.graphUsersWithinDistance,
        argsExpr,
        {
          requiredKeys: ["distance"],
          optionalKeys: [],
        },
      ),
      ...validateNonNegativeNumberField(
        RELATR_CAPABILITIES.graphUsersWithinDistance,
        argsExpr,
        "distance",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphUsersWithinDistance,
        ({ argsExpr }) => [
          ...validateObjectShape(
            RELATR_CAPABILITIES.graphUsersWithinDistance,
            argsExpr,
            {
              requiredKeys: ["distance"],
              optionalKeys: [],
            },
          ),
          ...validateNonNegativeNumberField(
            RELATR_CAPABILITIES.graphUsersWithinDistance,
            argsExpr,
            "distance",
          ),
        ],
      ),
  },
  {
    name: RELATR_CAPABILITIES.graphDegree,
    description: "Get the degree (number of follows) for a pubkey",
    argRule: {
      requiredKeys: ["pubkey"],
      description: "Requires a pubkey field.",
      example: { pubkey: "hex-pubkey" },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(RELATR_CAPABILITIES.graphDegree, argsExpr, {
        requiredKeys: ["pubkey"],
        optionalKeys: [],
      }),
      ...validateStringField(
        RELATR_CAPABILITIES.graphDegree,
        argsExpr,
        "pubkey",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(RELATR_CAPABILITIES.graphDegree, ({ argsExpr }) => [
        ...validateObjectShape(RELATR_CAPABILITIES.graphDegree, argsExpr, {
          requiredKeys: ["pubkey"],
          optionalKeys: [],
        }),
        ...validateStringField(
          RELATR_CAPABILITIES.graphDegree,
          argsExpr,
          "pubkey",
        ),
      ]),
  },
  {
    name: RELATR_CAPABILITIES.graphDegreeHistogram,
    description:
      "Get degree counts plus root-aware neighbor distance histograms for a pubkey",
    argRule: {
      requiredKeys: ["pubkey"],
      description: "Requires a pubkey field.",
      example: { pubkey: "hex-pubkey" },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(
        RELATR_CAPABILITIES.graphDegreeHistogram,
        argsExpr,
        {
          requiredKeys: ["pubkey"],
          optionalKeys: [],
        },
      ),
      ...validateStringField(
        RELATR_CAPABILITIES.graphDegreeHistogram,
        argsExpr,
        "pubkey",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.graphDegreeHistogram,
        ({ argsExpr }) => [
          ...validateObjectShape(
            RELATR_CAPABILITIES.graphDegreeHistogram,
            argsExpr,
            {
              requiredKeys: ["pubkey"],
              optionalKeys: [],
            },
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.graphDegreeHistogram,
            argsExpr,
            "pubkey",
          ),
        ],
      ),
  },
  {
    name: RELATR_CAPABILITIES.httpNip05Resolve,
    description: "Resolve NIP-05 identifier to pubkey",
    argRule: {
      requiredKeys: ["nip05"],
      description: "Requires a nip05 identifier field.",
      example: { nip05: "alice@example.com" },
    },
    validateArgs: ({ argsExpr }) => [
      ...validateObjectShape(RELATR_CAPABILITIES.httpNip05Resolve, argsExpr, {
        requiredKeys: ["nip05"],
        optionalKeys: [],
      }),
      ...validateStringField(
        RELATR_CAPABILITIES.httpNip05Resolve,
        argsExpr,
        "nip05",
      ),
    ],
    toPluginCapabilitySpec: () =>
      createCapabilitySpec(
        RELATR_CAPABILITIES.httpNip05Resolve,
        ({ argsExpr }) => [
          ...validateObjectShape(
            RELATR_CAPABILITIES.httpNip05Resolve,
            argsExpr,
            {
              requiredKeys: ["nip05"],
              optionalKeys: [],
            },
          ),
          ...validateStringField(
            RELATR_CAPABILITIES.httpNip05Resolve,
            argsExpr,
            "nip05",
          ),
        ],
      ),
  },
];

export const RELATR_VALIDATION_CAPABILITIES: Record<
  string,
  PluginCapabilitySpec
> = Object.fromEntries(
  RELATR_CAPABILITY_DEFINITIONS.map((definition) => [
    definition.name,
    definition.toPluginCapabilitySpec(),
  ]),
);

export function getRelatrCapabilityNames(): string[] {
  return RELATR_CAPABILITY_DEFINITIONS.map((definition) => definition.name);
}

export function isRelatrCapabilityName(name: string): boolean {
  return RELATR_CAPABILITY_DEFINITIONS.some(
    (definition) => definition.name === name,
  );
}
