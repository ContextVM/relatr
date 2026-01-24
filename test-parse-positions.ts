#!/usr/bin/env bun

import { parse } from "@enspirit/elo";

console.log("Checking if parse() includes source positions...\n");

// Test with a more complex expression
const source = `
let
  x = cap('test.echo', {y: 2}),
  z = cap('test.add', {a: 1, b: 2})
in
x.y + z
`;

const ast = parse(source);

function inspect(node: any, depth = 0) {
  const indent = "  ".repeat(depth);
  if (node === null || typeof node !== "object") {
    console.log(`${indent}${node}`);
    return;
  }

  // Check for position/location info
  const hasPosition =
    node.start !== undefined ||
    node.end !== undefined ||
    node.loc !== undefined;
  if (hasPosition) {
    console.log(
      `${indent}${node.type} { position: start=${node.start}, end=${node.end} }`,
    );
  } else {
    console.log(`${indent}${node.type}`);
  }

  for (const key of Object.keys(node)) {
    if (["type", "start", "end", "loc"].includes(key)) continue;
    const value = node[key];
    if (Array.isArray(value)) {
      console.log(`${indent}  ${key}:`);
      value.forEach((v: any) => inspect(v, depth + 2));
    } else if (typeof value === "object" && value !== null) {
      console.log(`${indent}  ${key}:`);
      inspect(value, depth + 2);
    }
  }
}

inspect(ast);

// Specifically look for function_call nodes
function findFunctionCalls(node: any): any[] {
  const calls: any[] = [];
  if (!node || typeof node !== "object") return calls;

  if (node.type === "function_call") {
    calls.push(node);
  }

  for (const key of Object.keys(node)) {
    const value = node[key];
    if (Array.isArray(value)) {
      value.forEach((v: any) => calls.push(...findFunctionCalls(v)));
    } else if (typeof value === "object" && value !== null) {
      calls.push(...findFunctionCalls(value));
    }
  }

  return calls;
}

const capCalls = findFunctionCalls(ast);
console.log("\nFound cap calls:");
capCalls.forEach((call, i) => {
  console.log(
    `  ${i}: name=${call.name}, start=${call.start}, end=${call.end}`,
  );
});
