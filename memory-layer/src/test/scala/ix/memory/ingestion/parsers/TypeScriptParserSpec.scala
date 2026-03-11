package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.model.NodeKind
import io.circe.Json

class TypeScriptParserSpec extends AnyFlatSpec with Matchers {
  val parser = new TypeScriptParser()

  val sampleCode: String = scala.io.Source.fromResource("fixtures/api.ts").mkString

  // --- Tests using fixture file ---

  "TypeScriptParser" should "extract classes and functions from TypeScript source" in {
    val result = parser.parse("api.ts", sampleCode)
    val names = result.entities.map(_.name)
    names should contain("ApiClient")
    names should contain("createClient")
    names should contain("fetchAllUsers")
  }

  it should "extract methods from classes" in {
    val result = parser.parse("api.ts", sampleCode)
    val methods = result.entities.filter(_.kind == NodeKind.Method)
    val names = methods.map(_.name)
    names should contain("getUser")
    names should contain("updateUser")
    names should contain("parseResponse")
  }

  it should "set language attr to typescript" in {
    val result = parser.parse("api.ts", sampleCode)
    val file = result.entities.find(_.kind == NodeKind.File).get
    file.attrs("language").asString shouldBe Some("typescript")
  }

  it should "extract import relationships" in {
    val result = parser.parse("api.ts", sampleCode)
    val imports = result.relationships.filter(_.predicate == "IMPORTS")
    imports.size should be >= 2
  }

  it should "extract class-to-method CONTAINS edges" in {
    val result = parser.parse("api.ts", sampleCode)
    val contains = result.relationships.filter(_.predicate == "CONTAINS")
    val classContains = contains.filter(_.srcName == "ApiClient")
    classContains.size should be >= 3
  }

  it should "extract function call relationships" in {
    val result = parser.parse("api.ts", sampleCode)
    val calls = result.relationships.filter(_.predicate == "CALLS")
    calls.size should be >= 1
  }

  it should "extract interface definitions" in {
    val result = parser.parse("api.ts", sampleCode)
    val names = result.entities.map(_.name)
    names should contain("UserResponse")
  }

  it should "store method/function signature as summary attr" in {
    val result = parser.parse("api.ts", sampleCode)
    val funcs = result.entities.filter(e => e.kind == NodeKind.Function || e.kind == NodeKind.Method)
    funcs should not be empty
    funcs.foreach { f =>
      f.attrs.get("summary") shouldBe defined
      f.attrs("summary").asString.get should not be empty
    }
  }

  it should "not store raw source content on File entity" in {
    val result = parser.parse("api.ts", sampleCode)
    val file = result.entities.find(_.kind == NodeKind.File).get
    file.attrs.get("content") shouldBe None
  }

  it should "truncate summary to 120 chars" in {
    val longSignature = "export async function veryLongFunctionNameThatExceedsTheLimit(paramA: string, paramB: number, paramC: boolean, paramD: SomeType, paramE: AnotherType): Promise<Result> {"
    val longSource = longSignature + "\n  return null;\n}\n"
    val result = parser.parse("long.ts", longSource)
    val func = result.entities.find(_.kind == NodeKind.Function).get
    val summary = func.attrs("summary").asString.get
    summary.length should be <= 120
  }

  // --- Tests using inline source ---

  it should "create a File entity for the source file" in {
    val result = parser.parse("app.ts", "const x = 1;")
    result.entities.exists(e => e.name == "app.ts" && e.kind == NodeKind.File) shouldBe true
  }

  it should "extract class definitions" in {
    val source = """
      |export class UserService {
      |  private db: Database;
      |
      |  getUser(id: string): User {
      |    return this.db.find(id);
      |  }
      |}
    """.stripMargin
    val result = parser.parse("service.ts", source)
    result.entities.exists(e => e.name == "UserService" && e.kind == NodeKind.Class) shouldBe true
    result.relationships.exists(r => r.srcName == "service.ts" && r.dstName == "UserService" && r.predicate == "CONTAINS") shouldBe true
  }

  it should "extract function definitions" in {
    val source = """
      |export function calculateTotal(items: Item[]): number {
      |  return items.reduce((sum, i) => sum + i.price, 0);
      |}
      |
      |async function fetchData(url: string): Promise<Response> {
      |  return fetch(url);
      |}
    """.stripMargin
    val result = parser.parse("utils.ts", source)
    result.entities.exists(e => e.name == "calculateTotal" && e.kind == NodeKind.Function) shouldBe true
    result.entities.exists(e => e.name == "fetchData" && e.kind == NodeKind.Function) shouldBe true
  }

  it should "extract arrow function declarations" in {
    val source = """
      |export const handler = async (req: Request): Promise<Response> => {
      |  return new Response("ok");
      |};
    """.stripMargin
    val result = parser.parse("handler.ts", source)
    result.entities.exists(e => e.name == "handler" && e.kind == NodeKind.Function) shouldBe true
  }

  it should "extract interface definitions with ts_kind attr" in {
    val source = """
      |export interface UserProps {
      |  name: string;
      |  age: number;
      |}
    """.stripMargin
    val result = parser.parse("types.ts", source)
    val iface = result.entities.find(e => e.name == "UserProps")
    iface shouldBe defined
    iface.get.kind shouldBe NodeKind.Interface
    iface.get.attrs.get("ts_kind").map(_.noSpaces) shouldBe Some("\"interface\"")
  }

  it should "extract type alias definitions" in {
    val source = """
      |export type UserId = string;
      |type Config<T> = Partial<T> & Required<BaseConfig>;
    """.stripMargin
    val result = parser.parse("types.ts", source)
    result.entities.exists(e => e.name == "UserId") shouldBe true
    result.entities.exists(e => e.name == "Config") shouldBe true
  }

  it should "extract import relationships from various import styles" in {
    val source = """
      |import { Router } from 'express';
      |import * as path from 'node:path';
      |import './side-effect';
    """.stripMargin
    val result = parser.parse("app.ts", source)
    result.relationships.exists(r => r.dstName == "express" && r.predicate == "IMPORTS") shouldBe true
    result.relationships.exists(r => r.dstName == "node:path" && r.predicate == "IMPORTS") shouldBe true
  }

  it should "detect methods inside classes" in {
    val source = """
      |class Api {
      |  async fetch(url: string) {
      |    return this.http.get(url);
      |  }
      |
      |  private parse(data: string) {
      |    return data.split(',');
      |  }
      |}
    """.stripMargin
    val result = parser.parse("api.ts", source)
    result.entities.exists(e => e.name == "fetch" && e.kind == NodeKind.Method) shouldBe true
    result.entities.exists(e => e.name == "parse" && e.kind == NodeKind.Method) shouldBe true
    result.relationships.exists(r => r.srcName == "Api" && r.dstName == "fetch" && r.predicate == "CONTAINS") shouldBe true
    result.relationships.exists(r => r.srcName == "Api" && r.dstName == "parse" && r.predicate == "CONTAINS") shouldBe true
  }

  it should "extract function call relationships from function bodies" in {
    val source = """
      |function main() {
      |  const data = loadConfig();
      |  processData(data);
      |}
    """.stripMargin
    val result = parser.parse("main.ts", source)
    result.relationships.exists(r => r.srcName == "main" && r.dstName == "loadConfig" && r.predicate == "CALLS") shouldBe true
    result.relationships.exists(r => r.srcName == "main" && r.dstName == "processData" && r.predicate == "CALLS") shouldBe true
  }

  it should "filter TypeScript builtins from CALLS" in {
    val source = """
      |function test() {
      |  console.log("hi");
      |  const n = parseInt("42");
      |  myFunction();
      |}
    """.stripMargin
    val result = parser.parse("test.ts", source)
    result.relationships.exists(r => r.predicate == "CALLS" && r.dstName == "console") shouldBe false
    result.relationships.exists(r => r.predicate == "CALLS" && r.dstName == "parseInt") shouldBe false
    result.relationships.exists(r => r.predicate == "CALLS" && r.dstName == "myFunction") shouldBe true
  }

  it should "parse .tsx files with JSX" in {
    val source = """
      |import React from 'react';
      |
      |interface Props {
      |  name: string;
      |}
      |
      |export function Greeting({ name }: Props) {
      |  return <div>Hello {name}</div>;
      |}
    """.stripMargin
    val result = parser.parse("Greeting.tsx", source)
    result.entities.exists(e => e.name == "Greeting" && e.kind == NodeKind.Function) shouldBe true
    result.entities.exists(e => e.name == "Props") shouldBe true
    result.relationships.exists(r => r.dstName == "react" && r.predicate == "IMPORTS") shouldBe true
  }

  it should "use Interface kind for interfaces" in {
    val source = """
      |export interface UserProps {
      |  name: string;
      |  age: number;
      |}
    """.stripMargin
    val result = parser.parse("types.ts", source)
    val iface = result.entities.find(e => e.name == "UserProps")
    iface shouldBe defined
    iface.get.kind shouldBe NodeKind.Interface
  }

  it should "use Method kind for class methods" in {
    val source = """
      |class Api {
      |  async fetch(url: string) {
      |    return this.http.get(url);
      |  }
      |  private parse(data: string) {
      |    return data.split(',');
      |  }
      |}
    """.stripMargin
    val result = parser.parse("api.ts", source)
    val methods = result.entities.filter(_.kind == NodeKind.Method)
    methods.map(_.name) should contain allOf ("fetch", "parse")
  }

  it should "emit CONTAINS edges from file to class" in {
    val source = """
      |export class UserService {
      |  getUser(id: string): User {
      |    return this.db.find(id);
      |  }
      |}
    """.stripMargin
    val result = parser.parse("service.ts", source)
    result.relationships.exists(r =>
      r.srcName == "service.ts" && r.dstName == "UserService" && r.predicate == "CONTAINS"
    ) shouldBe true
  }

  it should "emit CONTAINS edges from class to method" in {
    val source = """
      |class Api {
      |  fetch(url: string) {
      |    return url;
      |  }
      |}
    """.stripMargin
    val result = parser.parse("api.ts", source)
    result.relationships.exists(r =>
      r.srcName == "Api" && r.dstName == "fetch" && r.predicate == "CONTAINS"
    ) shouldBe true
  }

  it should "store visibility attr on methods" in {
    val source = """
      |class Api {
      |  private parse(data: string) {
      |    return data;
      |  }
      |  public fetch(url: string) {
      |    return url;
      |  }
      |}
    """.stripMargin
    val result = parser.parse("api.ts", source)
    val parse = result.entities.find(_.name == "parse").get
    parse.attrs.get("visibility").flatMap(_.asString) shouldBe Some("private")
    val fetch = result.entities.find(_.name == "fetch").get
    fetch.attrs.get("visibility").flatMap(_.asString) shouldBe Some("public")
  }

  it should "store signature attr on methods" in {
    val source = """
      |class Api {
      |  async fetch(url: string): Promise<Response> {
      |    return url;
      |  }
      |}
    """.stripMargin
    val result = parser.parse("api.ts", source)
    val fetch = result.entities.find(_.name == "fetch").get
    fetch.attrs.get("signature").flatMap(_.asString) shouldBe defined
    fetch.attrs("signature").asString.get should include("fetch")
  }

  // --- Symbol span tests ---

  it should "compute lineStart and lineEnd for classes" in {
    val source = """// header
      |
      |export class UserService {
      |  getUser(id: string): User {
      |    return this.db.find(id);
      |  }
      |}
      |
      |// footer
    """.stripMargin
    val result = parser.parse("service.ts", source)
    val cls = result.entities.find(e => e.name == "UserService" && e.kind == NodeKind.Class).get
    cls.lineStart should be >= 1
    cls.lineEnd should be > cls.lineStart
  }

  it should "extract CALLS between module-level functions" in {
    val source = """
      |export async function resolveEntityFull(client: any, symbol: string) {
      |  const result = pickBest(candidates, symbol);
      |  return result;
      |}
      |
      |function pickBest(candidates: any[], symbol: string) {
      |  return candidates[0];
      |}
    """.stripMargin
    val result = parser.parse("resolve.ts", source)
    result.relationships.exists(r =>
      r.srcName == "resolveEntityFull" && r.dstName == "pickBest" && r.predicate == "CALLS"
    ) shouldBe true
  }

  it should "extract CALLS for await-prefixed function calls" in {
    val source = """
      |async function processData(url: string) {
      |  const data = await fetchRemote(url);
      |  return transform(data);
      |}
    """.stripMargin
    val result = parser.parse("process.ts", source)
    result.relationships.exists(r =>
      r.srcName == "processData" && r.dstName == "fetchRemote" && r.predicate == "CALLS"
    ) shouldBe true
    result.relationships.exists(r =>
      r.srcName == "processData" && r.dstName == "transform" && r.predicate == "CALLS"
    ) shouldBe true
  }

  it should "extract CALLS through functions with object-type parameters" in {
    // This is the exact pattern that broke pickBest extraction in resolve.ts:
    // the { kind?: string; path?: string } type annotation was confusing
    // findBraceBlockEnd because braces in the type balanced on the same line.
    val source = """
      |export async function resolveEntityFull(
      |  client: IxClient,
      |  symbol: string,
      |  preferredKinds: string[],
      |  opts?: { kind?: string; path?: string }
      |): Promise<ResolveResult> {
      |  const exactName = nodes.filter((n: any) => n.name === symbol);
      |  const winner = pickBest(exactName, symbol, preferredKinds, opts);
      |  if (winner) return winner;
      |  return { resolved: false, ambiguous: false };
      |}
      |
      |function pickBest(
      |  candidates: any[],
      |  symbol: string,
      |  preferredKinds: string[],
      |  opts?: { kind?: string; path?: string }
      |): ResolveResult | null {
      |  const scored = candidates.map(n => ({
      |    node: n,
      |    score: scoreCandidate(n, symbol, opts),
      |  }));
      |  scored.sort((a, b) => a.score - b.score);
      |  return scored.length > 0 ? scored[0] : null;
      |}
    """.stripMargin
    val result = parser.parse("resolve.ts", source)

    // resolveEntityFull should call pickBest
    result.relationships.exists(r =>
      r.srcName == "resolveEntityFull" && r.dstName == "pickBest" && r.predicate == "CALLS"
    ) shouldBe true

    // pickBest should call scoreCandidate (not map/sort which are builtins)
    result.relationships.exists(r =>
      r.srcName == "pickBest" && r.dstName == "scoreCandidate" && r.predicate == "CALLS"
    ) shouldBe true

    // Array builtins should NOT appear as CALLS targets
    result.relationships.exists(r =>
      r.predicate == "CALLS" && r.dstName == "map"
    ) shouldBe false
    result.relationships.exists(r =>
      r.predicate == "CALLS" && r.dstName == "sort"
    ) shouldBe false
  }

  it should "handle braces in function return types" in {
    val source = """
      |function getData(): { name: string; age: number } {
      |  return processResult();
      |}
    """.stripMargin
    val result = parser.parse("data.ts", source)
    result.relationships.exists(r =>
      r.srcName == "getData" && r.dstName == "processResult" && r.predicate == "CALLS"
    ) shouldBe true
  }

  it should "handle class method calls and this.method patterns" in {
    val source = """
      |class Service {
      |  async process(input: string) {
      |    const data = this.validate(input);
      |    return transform(data);
      |  }
      |
      |  private validate(s: string) {
      |    return check(s);
      |  }
      |}
    """.stripMargin
    val result = parser.parse("service.ts", source)
    // process should call transform (bare function call)
    result.relationships.exists(r =>
      r.srcName == "process" && r.dstName == "transform" && r.predicate == "CALLS"
    ) shouldBe true
    // validate should call check
    result.relationships.exists(r =>
      r.srcName == "validate" && r.dstName == "check" && r.predicate == "CALLS"
    ) shouldBe true
  }

  it should "not extract builtins like filter, map, forEach as CALLS" in {
    val source = """
      |function processItems(items: Item[]) {
      |  const filtered = items.filter(i => i.active);
      |  const mapped = filtered.map(i => i.name);
      |  mapped.forEach(n => console.log(n));
      |  const found = items.find(i => i.id === "x");
      |  items.reduce((acc, i) => acc + i.value, 0);
      |  const joined = mapped.join(", ");
      |  return realHelper(found);
      |}
    """.stripMargin
    val result = parser.parse("process.ts", source)
    val calls = result.relationships.filter(r => r.predicate == "CALLS" && r.srcName == "processItems")
    // Should only have realHelper
    calls.map(_.dstName) should contain("realHelper")
    calls.map(_.dstName) should not contain "filter"
    calls.map(_.dstName) should not contain "map"
    calls.map(_.dstName) should not contain "forEach"
    calls.map(_.dstName) should not contain "find"
    calls.map(_.dstName) should not contain "reduce"
    calls.map(_.dstName) should not contain "join"
  }

  // --- File-level CALLS tests ---

  it should "extract calls from anonymous callback bodies" in {
    val source = """
      |import { Command } from "commander";
      |program.command("test").action(async (opts) => {
      |  const result = await resolveEntity(client, name);
      |  printResolved(result);
      |});
    """.stripMargin
    val result = parser.parse("test.ts", source)
    val calls = result.relationships.filter(r => r.predicate == "CALLS" && r.srcName == "test.ts")
    calls.map(_.dstName) should contain allOf ("resolveEntity", "printResolved")
  }

  // --- Named import bindings tests ---

  it should "extract named import bindings" in {
    val source = """import { pickBest, resolveEntity } from "./resolve.js";"""
    val result = parser.parse("api.ts", source)
    val imports = result.relationships.filter(_.predicate == "IMPORTS")
    imports.map(_.dstName) should contain allOf ("pickBest", "resolveEntity", "./resolve.js")
  }

  it should "handle import aliases" in {
    val source = """import { Foo as Bar } from "./mod.js";"""
    val result = parser.parse("test.ts", source)
    val imports = result.relationships.filter(_.predicate == "IMPORTS")
    imports.map(_.dstName) should contain ("Bar")
    imports.map(_.dstName) should not contain ("Foo")
  }

  // --- Export tracking tests ---

  it should "track exported entities" in {
    val source = """export function verify() { return true; }"""
    val result = parser.parse("auth.ts", source)
    val func = result.entities.find(_.name == "verify").get
    func.attrs("exported") shouldBe Json.fromBoolean(true)
  }

  it should "mark non-exported entities" in {
    val source = """function helper() { return 1; }"""
    val result = parser.parse("util.ts", source)
    val func = result.entities.find(_.name == "helper").get
    func.attrs("exported") shouldBe Json.fromBoolean(false)
  }

  it should "not emit file-level CALLS for locally defined functions" in {
    val source = """
      |export function registerCommand(program: any): void {
      |  program.action(async () => {
      |    const result = await doWork();
      |  });
      |}
    """.stripMargin
    val result = parser.parse("cmd.ts", source)
    val fileCalls = result.relationships.filter(r =>
      r.predicate == "CALLS" && r.srcName == "cmd.ts")
    fileCalls.map(_.dstName) should not contain ("registerCommand")
  }

  it should "not emit file-level CALLS for code inside class bodies" in {
    val source = """
      |class Service {
      |  async handle() {
      |    return processData();
      |  }
      |}
      |initApp();
    """.stripMargin
    val result = parser.parse("app.ts", source)
    val fileCalls = result.relationships.filter(r =>
      r.predicate == "CALLS" && r.srcName == "app.ts")
    fileCalls.map(_.dstName) should contain ("initApp")
    fileCalls.map(_.dstName) should not contain ("processData")
    fileCalls.map(_.dstName) should not contain ("handle")
  }

  it should "compute method spans bounded within their class" in {
    val source = """export class Api {
      |  fetch(url: string) {
      |    return url;
      |  }
      |
      |  parse(data: string) {
      |    return data;
      |  }
      |}
    """.stripMargin
    val result = parser.parse("api.ts", source)
    val cls = result.entities.find(e => e.name == "Api" && e.kind == NodeKind.Class).get
    val methods = result.entities.filter(_.kind == NodeKind.Method)
    methods should not be empty
    methods.foreach { m =>
      m.lineStart should be >= cls.lineStart
      m.lineEnd should be <= cls.lineEnd
    }
  }
}
