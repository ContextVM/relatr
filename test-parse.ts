#!/usr/bin/env bun

// Quick test to see if @enspirit/elo has a parse function
import { compile, parse } from "@enspirit/elo";

console.log("Testing @enspirit/elo API...");

// Test if parse exists
console.log("parse function:", typeof parse);
console.log("compile function:", typeof compile);

if (typeof parse === "function") {
  console.log("\n✓ parse() exists!");

  // Try to parse a simple expression
  try {
    const ast = parse("1 + 2");
    console.log("AST for '1 + 2':", JSON.stringify(ast, null, 2));
  } catch (e) {
    console.log("Error parsing '1 + 2':", e);
  }

  // Try to parse a cap call
  try {
    const ast = parse("cap('test.echo', {x: 1})");
    console.log("\nAST for cap call:", JSON.stringify(ast, null, 2));
  } catch (e) {
    console.log("Error parsing cap call:", e);
  }

  // Try a more complex expression with cap
  try {
    const ast = parse("let x = cap('test.echo', {y: 2}) in x.y");
    console.log("\nAST for let expression:", JSON.stringify(ast, null, 2));
  } catch (e) {
    console.log("Error parsing let expression:", e);
  }
} else {
  console.log("\n✗ parse() does not exist or is not a function");
}

// Test compile for comparison
console.log("\n--- Testing compile() ---");
try {
  const fn = compile("1 + 2");
  console.log("compile('1 + 2') result:", typeof fn);
  if (typeof fn === "function") {
    console.log("Result:", fn({}));
  }
} catch (e) {
  console.log("Error compiling '1 + 2':", e);
}

try {
  const fn = compile("cap('test.echo', {x: 1})");
  console.log("\ncompile('cap(...)') result:", typeof fn);
} catch (e) {
  console.log("Error compiling cap call:", e);
  console.log("Error message:", e.message);
}
