package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.model.NodeKind

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
}
