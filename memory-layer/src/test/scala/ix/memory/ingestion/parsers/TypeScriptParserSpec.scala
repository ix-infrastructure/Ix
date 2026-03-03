package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import ix.memory.model.NodeKind

class TypeScriptParserSpec extends AnyFlatSpec with Matchers {

  val parser = new TypeScriptParser()

  // Test 1: Extract file entity
  "TypeScriptParser" should "create a File entity for the source file" in {
    val result = parser.parse("app.ts", "const x = 1;")
    result.entities.exists(e => e.name == "app.ts" && e.kind == NodeKind.File) shouldBe true
  }

  // Test 2: Extract class
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
    // File DEFINES UserService
    result.relationships.exists(r => r.srcName == "service.ts" && r.dstName == "UserService" && r.predicate == "DEFINES") shouldBe true
  }

  // Test 3: Extract functions
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

  // Test 4: Extract arrow functions
  it should "extract arrow function declarations" in {
    val source = """
      |export const handler = async (req: Request): Promise<Response> => {
      |  return new Response("ok");
      |};
    """.stripMargin
    val result = parser.parse("handler.ts", source)
    result.entities.exists(e => e.name == "handler" && e.kind == NodeKind.Function) shouldBe true
  }

  // Test 5: Extract interfaces
  it should "extract interface definitions" in {
    val source = """
      |export interface UserProps {
      |  name: string;
      |  age: number;
      |}
    """.stripMargin
    val result = parser.parse("types.ts", source)
    val iface = result.entities.find(e => e.name == "UserProps")
    iface shouldBe defined
    iface.get.kind shouldBe NodeKind.Class // using Class for interfaces
    iface.get.attrs.get("ts_kind").map(_.noSpaces) shouldBe Some("\"interface\"")
  }

  // Test 6: Extract type aliases
  it should "extract type alias definitions" in {
    val source = """
      |export type UserId = string;
      |type Config<T> = Partial<T> & Required<BaseConfig>;
    """.stripMargin
    val result = parser.parse("types.ts", source)
    result.entities.exists(e => e.name == "UserId") shouldBe true
    result.entities.exists(e => e.name == "Config") shouldBe true
  }

  // Test 7: Extract imports
  it should "extract import relationships" in {
    val source = """
      |import { Router } from 'express';
      |import * as path from 'node:path';
      |import './side-effect';
    """.stripMargin
    val result = parser.parse("app.ts", source)
    result.relationships.exists(r => r.dstName == "express" && r.predicate == "IMPORTS") shouldBe true
    result.relationships.exists(r => r.dstName == "node:path" && r.predicate == "IMPORTS") shouldBe true
  }

  // Test 8: Extract method-in-class
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
    // Api DEFINES fetch
    result.relationships.exists(r => r.srcName == "Api" && r.dstName == "fetch" && r.predicate == "DEFINES") shouldBe true
    result.relationships.exists(r => r.srcName == "Api" && r.dstName == "parse" && r.predicate == "DEFINES") shouldBe true
  }

  // Test 9: Extract function calls
  it should "extract function call relationships" in {
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

  // Test 10: Filter builtins from calls
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

  // Test 11: Handles .tsx files
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

  // Test 12: Language attrs set to "typescript"
  it should "set language attr to typescript" in {
    val result = parser.parse("app.ts", "const x = 1;")
    val fileEntity = result.entities.find(_.name == "app.ts")
    fileEntity shouldBe defined
    fileEntity.get.attrs.get("language").map(_.noSpaces) shouldBe Some("\"typescript\"")
  }
}
