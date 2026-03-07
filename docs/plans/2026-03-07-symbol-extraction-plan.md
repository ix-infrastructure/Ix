# Symbol-Level Extraction Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Evolve Ix from file-blob retrieval to symbol-centric scene-graph retrieval by adding 4 NodeKinds, enhancing parsers, boosting symbol relevance in queries, and improving search.

**Architecture:** Additive changes to 6 existing files. No new routes, tools, collections, or schema migrations. Parsers emit richer NodeKinds and CONTAINS edges. RelevanceScorer applies a kindBoost to prefer symbols over file blobs. Search AQL sorts symbols first and searches attrs.

**Tech Stack:** Scala 2.13, Cats Effect 3, ArangoDB AQL, ScalaTest (AnyFlatSpec + Matchers)

---

### Task 1: Add NodeKind variants (Object, Trait, Interface, Method)

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/model/Node.scala:8-56`
- Modify: `memory-layer/src/test/scala/ix/memory/model/ModelSpec.scala:70-89`

**Step 1: Write the failing test**

Add the 4 new variants to the existing `ModelSpec` NodeKind round-trip test.

In `memory-layer/src/test/scala/ix/memory/model/ModelSpec.scala`, replace the `variants` list in the `"NodeKind" should "encode and decode all variants correctly"` test (lines 71-83) with:

```scala
  "NodeKind" should "encode and decode all variants correctly" in {
    val variants: List[NodeKind] = List(
      NodeKind.Module,
      NodeKind.File,
      NodeKind.Class,
      NodeKind.Function,
      NodeKind.Variable,
      NodeKind.Config,
      NodeKind.ConfigEntry,
      NodeKind.Service,
      NodeKind.Endpoint,
      NodeKind.Intent,
      NodeKind.Decision,
      NodeKind.Doc,
      NodeKind.Object,
      NodeKind.Trait,
      NodeKind.Interface,
      NodeKind.Method
    )

    variants.foreach { nk =>
      val json = nk.asJson
      json.isString shouldBe true
      decode[NodeKind](json.noSpaces) shouldBe Right(nk)
    }
  }
```

**Step 2: Run test to verify it fails**

Run: `cd memory-layer && sbt "testOnly ix.memory.model.ModelSpec"`
Expected: Compilation failure — `Object`, `Trait`, `Interface`, `Method` not found in `NodeKind`

**Step 3: Write minimal implementation**

In `memory-layer/src/main/scala/ix/memory/model/Node.scala`, add 4 case objects and update `nameMap` + `encoder`:

```scala
sealed trait NodeKind
object NodeKind {
  case object Module      extends NodeKind
  case object File        extends NodeKind
  case object Class       extends NodeKind
  case object Function    extends NodeKind
  case object Variable    extends NodeKind
  case object Config      extends NodeKind
  case object ConfigEntry extends NodeKind
  case object Service     extends NodeKind
  case object Endpoint    extends NodeKind
  case object Intent      extends NodeKind
  case object Decision    extends NodeKind
  case object Doc         extends NodeKind
  case object Object      extends NodeKind
  case object Trait       extends NodeKind
  case object Interface   extends NodeKind
  case object Method      extends NodeKind

  private val nameMap: Map[String, NodeKind] = Map(
    "module"       -> Module,
    "file"         -> File,
    "class"        -> Class,
    "function"     -> Function,
    "variable"     -> Variable,
    "config"       -> Config,
    "config_entry" -> ConfigEntry,
    "service"      -> Service,
    "endpoint"     -> Endpoint,
    "intent"       -> Intent,
    "decision"     -> Decision,
    "doc"          -> Doc,
    "object"       -> Object,
    "trait"        -> Trait,
    "interface"    -> Interface,
    "method"       -> Method
  )

  implicit val encoder: Encoder[NodeKind] = Encoder[String].contramap {
    case Module      => "module"
    case File        => "file"
    case Class       => "class"
    case Function    => "function"
    case Variable    => "variable"
    case Config      => "config"
    case ConfigEntry => "config_entry"
    case Service     => "service"
    case Endpoint    => "endpoint"
    case Intent      => "intent"
    case Decision    => "decision"
    case Doc         => "doc"
    case Object      => "object"
    case Trait       => "trait"
    case Interface   => "interface"
    case Method      => "method"
  }

  implicit val decoder: Decoder[NodeKind] = Decoder[String].emap { s =>
    nameMap.get(s).toRight(s"Unknown NodeKind: $s")
  }
}
```

**Step 4: Run test to verify it passes**

Run: `cd memory-layer && sbt "testOnly ix.memory.model.ModelSpec"`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/model/Node.scala memory-layer/src/test/scala/ix/memory/model/ModelSpec.scala
git commit -m "feat: add Object, Trait, Interface, Method NodeKinds"
```

---

### Task 2: Enhance ScalaParser — use correct NodeKinds, add signature/visibility

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/ingestion/parsers/ScalaParser.scala:1-220`
- Modify: `memory-layer/src/test/scala/ix/memory/ingestion/parsers/ScalaParserSpec.scala:1-129`

**Step 1: Write the failing tests**

Replace `ScalaParserSpec.scala` entirely. Key changes: expect `NodeKind.Trait` instead of `NodeKind.Class` for traits, `NodeKind.Object` for objects, `NodeKind.Method` for contained defs, `NodeKind.Function` for top-level defs. Add tests for `signature` and `visibility` attrs, and CONTAINS edges.

```scala
package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import ix.memory.model.NodeKind
import io.circe.Json

class ScalaParserSpec extends AnyFlatSpec with Matchers {
  val parser = new ScalaParser

  val sampleCode: String =
    """package ix.memory.context
      |
      |import cats.effect.IO
      |import ix.memory.model.{Claim, GraphNode}
      |
      |trait ConfidenceScorer {
      |  def score(claim: Claim, ctx: ScoringContext): ScoredClaim
      |}
      |
      |class ConfidenceScorerImpl extends ConfidenceScorer {
      |  override def score(claim: Claim, ctx: ScoringContext): ScoredClaim = {
      |    val base = computeBase(claim)
      |    ScoredClaim(claim, base)
      |  }
      |
      |  private def computeBase(claim: Claim): Double = {
      |    claim.provenance.sourceType match {
      |      case SourceType.Code => 0.9
      |      case _ => 0.5
      |    }
      |  }
      |}
      |
      |object ConfidenceScorerImpl {
      |  def apply(): ConfidenceScorerImpl = new ConfidenceScorerImpl
      |}
      |""".stripMargin

  "ScalaParser" should "create a File entity" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val file = result.entities.find(_.kind == NodeKind.File)
    file shouldBe defined
    file.get.name shouldBe "ConfidenceScorer.scala"
    file.get.attrs.get("language") shouldBe Some(Json.fromString("scala"))
  }

  it should "extract trait definitions with Trait kind" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val traits = result.entities.filter(_.kind == NodeKind.Trait)
    traits.map(_.name) should contain("ConfidenceScorer")
  }

  it should "extract class definitions with Class kind" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val classes = result.entities.filter(_.kind == NodeKind.Class)
    classes.map(_.name) should contain("ConfidenceScorerImpl")
  }

  it should "extract object definitions with Object kind" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val objects = result.entities.filter(_.kind == NodeKind.Object)
    objects.map(_.name) should contain("ConfidenceScorerImpl")
  }

  it should "extract contained defs as Method kind" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val methods = result.entities.filter(_.kind == NodeKind.Method)
    methods.map(_.name) should contain allOf ("score", "computeBase", "apply")
  }

  it should "extract top-level defs as Function kind" in {
    val code =
      """def topLevel(x: Int): Int = x + 1
        |
        |class Foo {
        |  def bar(): Unit = ()
        |}
        |""".stripMargin
    val result = parser.parse("TopLevel.scala", code)
    val functions = result.entities.filter(_.kind == NodeKind.Function)
    functions.map(_.name) should contain("topLevel")
    val methods = result.entities.filter(_.kind == NodeKind.Method)
    methods.map(_.name) should contain("bar")
  }

  it should "extract import statements" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val imports = result.entities.filter(_.kind == NodeKind.Module)
    imports.map(_.name) should contain allOf ("cats.effect.IO", "ix.memory.model")
  }

  it should "create DEFINES relationships from file to types" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val defines = result.relationships.filter(_.predicate == "DEFINES")
    defines.map(r => (r.srcName, r.dstName)) should contain allOf (
      ("ConfidenceScorer.scala", "ConfidenceScorer"),
      ("ConfidenceScorer.scala", "ConfidenceScorerImpl")
    )
  }

  it should "create CONTAINS relationships from types to methods" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val contains = result.relationships.filter(_.predicate == "CONTAINS")
    contains.map(r => (r.srcName, r.dstName)) should contain allOf (
      ("ConfidenceScorerImpl", "score"),
      ("ConfidenceScorerImpl", "computeBase")
    )
  }

  it should "create IMPORTS relationships" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val imports = result.relationships.filter(_.predicate == "IMPORTS")
    imports should not be empty
  }

  it should "store method signature attr" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val method = result.entities.find(_.name == "computeBase").get
    val sig = method.attrs.get("signature").flatMap(_.asString)
    sig shouldBe defined
    sig.get should include("computeBase")
  }

  it should "store visibility attr for private defs" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val method = result.entities.find(_.name == "computeBase").get
    val vis = method.attrs.get("visibility").flatMap(_.asString)
    vis shouldBe Some("private")
  }

  it should "default visibility to public" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    // "score" has override but no private/protected
    val method = result.entities.find(e => e.name == "score" && e.kind == NodeKind.Method)
    method shouldBe defined
    val vis = method.get.attrs.get("visibility").flatMap(_.asString)
    vis shouldBe Some("public")
  }

  it should "not store raw file content" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val file = result.entities.find(_.kind == NodeKind.File).get
    file.attrs.get("content") shouldBe None
  }

  it should "handle case classes" in {
    val code = """case class Foo(bar: String, baz: Int)""".stripMargin
    val result = parser.parse("Foo.scala", code)
    val classes = result.entities.filter(_.kind == NodeKind.Class)
    classes.map(_.name) should contain("Foo")
    // case classes still keep scala_kind attr
    val foo = classes.find(_.name == "Foo").get
    foo.attrs.get("scala_kind") shouldBe Some(Json.fromString("case_class"))
  }

  it should "preserve scala_kind attr on traits" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val tr = result.entities.find(_.name == "ConfidenceScorer").get
    tr.attrs.get("scala_kind") shouldBe Some(Json.fromString("trait"))
  }

  it should "preserve scala_kind attr on objects" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val obj = result.entities.find(e => e.name == "ConfidenceScorerImpl" && e.kind == NodeKind.Object).get
    obj.attrs.get("scala_kind") shouldBe Some(Json.fromString("object"))
  }
}
```

**Step 2: Run tests to verify they fail**

Run: `cd memory-layer && sbt "testOnly ix.memory.ingestion.parsers.ScalaParserSpec"`
Expected: FAIL — traits still emit `NodeKind.Class`, methods still emit `NodeKind.Function`, no CONTAINS edges, no signature/visibility attrs

**Step 3: Write minimal implementation**

Replace `ScalaParser.scala` with the enhanced version. Key changes:
- Trait → `NodeKind.Trait`
- Object → `NodeKind.Object`
- Class/CaseClass → `NodeKind.Class` (unchanged)
- Def inside container → `NodeKind.Method` + CONTAINS edge
- Def top-level → `NodeKind.Function` + DEFINES edge
- Add `signature` attr (trimmed first line up to `=` or `{`)
- Add `visibility` attr (`private`/`protected`/`public`)

```scala
package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json

import scala.util.matching.Regex

class ScalaParser extends Parser {

  private val TraitPattern: Regex      = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*trait\s+(\w+)""".r
  private val ClassPattern: Regex      = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*class\s+(\w+)""".r
  private val CaseClassPattern: Regex  = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*case\s+class\s+(\w+)""".r
  private val ObjectPattern: Regex     = """^\s*(?:sealed\s+|abstract\s+|private\s+|protected\s+)*(?:case\s+)?object\s+(\w+)""".r
  private val DefPattern: Regex        = """^\s*(?:override\s+)?(?:private(?:\[\w+\])?\s+|protected(?:\[\w+\])?\s+)?(?:final\s+)?def\s+(\w+)""".r
  private val ImportPattern: Regex     = """^\s*import\s+(.+)$""".r

  private val VisibilityPattern: Regex = """(?:override\s+)?(?:(private|protected)(?:\[\w+\])?\s+)""".r

  def parse(fileName: String, source: String): ParseResult = {
    val lines = source.split("\n", -1)

    val fileEntity = ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("scala")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    var entities      = Vector(fileEntity)
    var relationships = Vector.empty[ParsedRelationship]

    var typeRanges = Vector.empty[(String, Int, Int)]

    for ((line, idx) <- lines.zipWithIndex) {
      val lineNum = idx + 1
      val trimmed = line.trim

      if (trimmed.startsWith("//") || trimmed.startsWith("*") || trimmed.startsWith("/*")) {
        // no-op
      } else {

        val handledAsType = CaseClassPattern.findFirstMatchIn(line) match {
          case Some(m) =>
            val name = m.group(1)
            val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
            entities = entities :+ ParsedEntity(
              name      = name,
              kind      = NodeKind.Class,
              attrs     = Map("scala_kind" -> Json.fromString("case_class"), "language" -> Json.fromString("scala")),
              lineStart = lineNum,
              lineEnd   = endLine
            )
            relationships = relationships :+ ParsedRelationship(fileName, name, "DEFINES")
            typeRanges = typeRanges :+ (name, lineNum, endLine)
            true

          case None =>
            TraitPattern.findFirstMatchIn(line) match {
              case Some(m) =>
                val name = m.group(1)
                val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
                entities = entities :+ ParsedEntity(
                  name      = name,
                  kind      = NodeKind.Trait,
                  attrs     = Map("scala_kind" -> Json.fromString("trait"), "language" -> Json.fromString("scala")),
                  lineStart = lineNum,
                  lineEnd   = endLine
                )
                relationships = relationships :+ ParsedRelationship(fileName, name, "DEFINES")
                typeRanges = typeRanges :+ (name, lineNum, endLine)
                true

              case None =>
                ObjectPattern.findFirstMatchIn(line) match {
                  case Some(m) =>
                    val name = m.group(1)
                    val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
                    entities = entities :+ ParsedEntity(
                      name      = name,
                      kind      = NodeKind.Object,
                      attrs     = Map("scala_kind" -> Json.fromString("object"), "language" -> Json.fromString("scala")),
                      lineStart = lineNum,
                      lineEnd   = endLine
                    )
                    relationships = relationships :+ ParsedRelationship(fileName, name, "DEFINES")
                    typeRanges = typeRanges :+ (name, lineNum, endLine)
                    true

                  case None =>
                    ClassPattern.findFirstMatchIn(line) match {
                      case Some(m) =>
                        val name = m.group(1)
                        val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)
                        entities = entities :+ ParsedEntity(
                          name      = name,
                          kind      = NodeKind.Class,
                          attrs     = Map("scala_kind" -> Json.fromString("class"), "language" -> Json.fromString("scala")),
                          lineStart = lineNum,
                          lineEnd   = endLine
                        )
                        relationships = relationships :+ ParsedRelationship(fileName, name, "DEFINES")
                        typeRanges = typeRanges :+ (name, lineNum, endLine)
                        true
                      case None => false
                    }
                }
            }
        }

        if (!handledAsType) {
          DefPattern.findFirstMatchIn(line).foreach { m =>
            val funcName = m.group(1)
            val endLine = findBraceBlockEnd(lines, idx).getOrElse(lineNum)

            val signature = extractSignature(trimmed)
            val visibility = extractVisibility(trimmed)

            val enclosing = typeRanges.find { case (_, start, end) =>
              lineNum > start && lineNum <= end
            }

            val (kind, rel) = enclosing match {
              case Some((typeName, _, _)) =>
                (NodeKind.Method, ParsedRelationship(typeName, funcName, "CONTAINS"))
              case None =>
                (NodeKind.Function, ParsedRelationship(fileName, funcName, "DEFINES"))
            }

            entities = entities :+ ParsedEntity(
              name      = funcName,
              kind      = kind,
              attrs     = Map(
                "language"   -> Json.fromString("scala"),
                "summary"    -> Json.fromString(signature),
                "signature"  -> Json.fromString(signature),
                "visibility" -> Json.fromString(visibility)
              ),
              lineStart = lineNum,
              lineEnd   = endLine
            )

            relationships = relationships :+ rel
          }
        }

        ImportPattern.findFirstMatchIn(line).foreach { m =>
          val importPath = m.group(1).trim
          val moduleName = if (importPath.contains("{")) {
            importPath.substring(0, importPath.indexOf('{')).stripSuffix(".").trim
          } else {
            importPath
          }

          if (!entities.exists(e => e.name == moduleName && e.kind == NodeKind.Module)) {
            entities = entities :+ ParsedEntity(
              name      = moduleName,
              kind      = NodeKind.Module,
              attrs     = Map.empty,
              lineStart = lineNum,
              lineEnd   = lineNum
            )
          }
          relationships = relationships :+ ParsedRelationship(fileName, moduleName, "IMPORTS")
        }

      }
    }

    ParseResult(entities, relationships)
  }

  private def extractSignature(trimmedLine: String): String = {
    val sig = trimmedLine
      .replaceAll("""\s*\{.*""", "")
      .replaceAll("""\s*=\s*\{.*""", "")
      .replaceAll("""\s*=\s*$""", "")
      .take(120)
    sig
  }

  private def extractVisibility(trimmedLine: String): String = {
    val cleaned = trimmedLine.replaceFirst("^override\\s+", "")
    if (cleaned.startsWith("private"))        "private"
    else if (cleaned.startsWith("protected")) "protected"
    else                                      "public"
  }

  private def findBraceBlockEnd(lines: Array[String], startIdx: Int): Option[Int] = {
    var braceCount = 0
    var foundOpen = false
    var i = startIdx

    while (i < lines.length) {
      val line = lines(i)
      for (ch <- line) {
        ch match {
          case '{' =>
            braceCount += 1
            foundOpen = true
          case '}' =>
            braceCount -= 1
            if (foundOpen && braceCount == 0) {
              return Some(i + 1)
            }
          case _ =>
        }
      }
      i += 1
    }

    if (foundOpen) Some(lines.length) else None
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd memory-layer && sbt "testOnly ix.memory.ingestion.parsers.ScalaParserSpec"`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/ingestion/parsers/ScalaParser.scala memory-layer/src/test/scala/ix/memory/ingestion/parsers/ScalaParserSpec.scala
git commit -m "feat: ScalaParser emits Trait/Object/Method kinds, signature, visibility, CONTAINS edges"
```

---

### Task 3: Enhance TypeScriptParser — use Interface/Method kinds, add CONTAINS edges, attrs

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/ingestion/parsers/TypeScriptParser.scala:1-329`
- Modify: `memory-layer/src/test/scala/ix/memory/ingestion/parsers/TypeScriptParserSpec.scala:1-229`

**Step 1: Write the failing tests**

Add/update tests in `TypeScriptParserSpec.scala`. Key new assertions:
- Interfaces use `NodeKind.Interface` (not `NodeKind.Class`)
- Class methods use `NodeKind.Method` (not `NodeKind.Function`)
- CONTAINS edges from file→class and class→method exist
- Methods have `signature` and `visibility` attrs

Add these test cases to the existing spec (append before the closing `}`):

```scala
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
      |
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
```

Also update the existing interface test (lines 134-146) to expect `NodeKind.Interface`:

```scala
  it should "extract interface definitions with Interface kind" in {
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
```

And update the method detection test (lines 169-184) to expect `Method` kind:

```scala
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
```

Update the "store method/function signature" test (lines 62-69) — methods are now `NodeKind.Method`, top-level functions stay `NodeKind.Function`:

```scala
  it should "store method/function signature as summary attr" in {
    val result = parser.parse("api.ts", sampleCode)
    val funcs = result.entities.filter(e => e.kind == NodeKind.Function || e.kind == NodeKind.Method)
    funcs should not be empty
    funcs.foreach { f =>
      f.attrs.get("summary") shouldBe defined
      f.attrs("summary").asString.get should not be empty
    }
  }
```

Update fixture-based "extract methods" test to check for `Method` kind:

```scala
  it should "extract methods from classes" in {
    val result = parser.parse("api.ts", sampleCode)
    val methods = result.entities.filter(_.kind == NodeKind.Method)
    val names = methods.map(_.name)
    names should contain("getUser")
    names should contain("updateUser")
    names should contain("parseResponse")
  }
```

**Step 2: Run tests to verify they fail**

Run: `cd memory-layer && sbt "testOnly ix.memory.ingestion.parsers.TypeScriptParserSpec"`
Expected: FAIL — interfaces still Class, methods still Function, no CONTAINS edges

**Step 3: Write minimal implementation**

Modify `TypeScriptParser.scala` with these changes:

1. **Interface**: Change `NodeKind.Class` → `NodeKind.Interface` at line 158
2. **Class methods in `extractMethods`**: Change `NodeKind.Function` → `NodeKind.Method` at line 243, change `"DEFINES"` → `"CONTAINS"` at line 250
3. **File→Class CONTAINS**: Add `ParsedRelationship(fileName, className, "CONTAINS")` after the DEFINES edge at line 60
4. **Visibility attr on methods**: Extract from method line
5. **Signature attr on methods**: Already stored as `summary`, add as `signature` too
6. **Duplicate guard for interfaces**: Change `e.kind == NodeKind.Class` → `e.kind == NodeKind.Interface` in the guard at line 154

The key code changes in `extractMethods`:

```scala
  private def extractMethods(
    lines: Array[String],
    classStartIdx: Int,
    classEndLine: Int,
    className: String
  ): (Vector[ParsedEntity], Vector[ParsedRelationship]) = {
    var entities = Vector.empty[ParsedEntity]
    var relationships = Vector.empty[ParsedRelationship]

    var i = classStartIdx + 1
    while (i < lines.length && (i + 1) <= classEndLine) {
      val line = lines(i)
      val lineNum = i + 1

      if (!line.trim.startsWith("//") && !line.trim.startsWith("*")) {
        MethodPattern.findFirstMatchIn(line).foreach { m =>
          val methodName = m.group(1)
          if (!TypeScriptKeywords.contains(methodName)) {
            val methodEnd = findBraceBlockEnd(lines, i)
            val summary = line.trim.take(120)
            val visibility = extractVisibility(line.trim)
            entities = entities :+ ParsedEntity(
              name      = methodName,
              kind      = NodeKind.Method,
              attrs     = Map(
                "language"   -> Json.fromString("typescript"),
                "summary"    -> Json.fromString(summary),
                "signature"  -> Json.fromString(summary),
                "visibility" -> Json.fromString(visibility)
              ),
              lineStart = lineNum,
              lineEnd   = methodEnd
            )
            relationships = relationships :+ ParsedRelationship(className, methodName, "CONTAINS")

            val calls = extractCalls(lines, i, methodEnd, methodName)
            relationships = relationships ++ calls
          }
        }
      }
      i += 1
    }

    (entities, relationships)
  }

  private def extractVisibility(trimmedLine: String): String = {
    if (trimmedLine.startsWith("private ") || trimmedLine.startsWith("private\t"))   "private"
    else if (trimmedLine.startsWith("protected ") || trimmedLine.startsWith("protected\t")) "protected"
    else "public"
  }
```

For the class entity — add CONTAINS after DEFINES:

```scala
        ClassPattern.findFirstMatchIn(line).foreach { m =>
          val className = m.group(1)
          val classEnd = findBraceBlockEnd(lines, idx)
          entities = entities :+ ParsedEntity(
            name      = className,
            kind      = NodeKind.Class,
            attrs     = Map("language" -> Json.fromString("typescript")),
            lineStart = lineNum,
            lineEnd   = classEnd
          )
          relationships = relationships :+ ParsedRelationship(fileName, className, "DEFINES")
          relationships = relationships :+ ParsedRelationship(fileName, className, "CONTAINS")
          classRanges = classRanges :+ (className, lineNum, classEnd)

          val methods = extractMethods(lines, idx, classEnd, className)
          entities = entities ++ methods._1
          relationships = relationships ++ methods._2
        }
```

For interfaces — change kind:

```scala
        InterfacePattern.findFirstMatchIn(line).foreach { m =>
          val ifaceName = m.group(1)
          if (!entities.exists(e => e.name == ifaceName && e.kind == NodeKind.Interface)) {
            val ifaceEnd = findBraceBlockEnd(lines, idx)
            entities = entities :+ ParsedEntity(
              name      = ifaceName,
              kind      = NodeKind.Interface,
              attrs     = Map(
                "language"  -> Json.fromString("typescript"),
                "ts_kind"   -> Json.fromString("interface")
              ),
              lineStart = lineNum,
              lineEnd   = ifaceEnd
            )
            relationships = relationships :+ ParsedRelationship(fileName, ifaceName, "DEFINES")
          }
        }
```

Also add `signature` attr to top-level functions (alongside existing `summary`):

```scala
          FuncPattern.findFirstMatchIn(line).foreach { m =>
            val funcName = m.group(1)
            val funcEnd = findBraceBlockEnd(lines, idx)
            val summary = line.trim.take(120)
            entities = entities :+ ParsedEntity(
              name      = funcName,
              kind      = NodeKind.Function,
              attrs     = Map(
                "language"   -> Json.fromString("typescript"),
                "summary"    -> Json.fromString(summary),
                "signature"  -> Json.fromString(summary),
                "visibility" -> Json.fromString("public")
              ),
              lineStart = lineNum,
              lineEnd   = funcEnd
            )
            // ... rest unchanged
```

Same for arrow functions / const functions.

**Step 4: Run tests to verify they pass**

Run: `cd memory-layer && sbt "testOnly ix.memory.ingestion.parsers.TypeScriptParserSpec"`
Expected: All tests PASS

**Step 5: Run all tests to check for regressions**

Run: `cd memory-layer && sbt test`
Expected: All tests PASS. Check especially that RoutesSpec, EndToEndSpec, and other integration tests still pass.

**Step 6: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/ingestion/parsers/TypeScriptParser.scala memory-layer/src/test/scala/ix/memory/ingestion/parsers/TypeScriptParserSpec.scala
git commit -m "feat: TypeScriptParser emits Interface/Method kinds, CONTAINS edges, signature/visibility"
```

---

### Task 4: Add kindBoost to RelevanceScorer

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/context/RelevanceScorer.scala:1-40`
- Modify: `memory-layer/src/test/scala/ix/memory/context/RelevanceScorerSpec.scala:1-80`

**Step 1: Write the failing tests**

Add tests to `RelevanceScorerSpec.scala`. The scorer needs a `nodeKindMap` parameter. Add these test cases:

```scala
  it should "boost symbol node claims with kindBoost 1.3x" in {
    val seedId = NodeId(UUID.randomUUID())
    val kindMap = Map(seedId -> NodeKind.Function)
    val claims = Vector(makeClaim(seedId))
    val result = RelevanceScorer.scoreWithTerms(claims, Set(seedId), Vector.empty, Vector.empty, kindMap)
    // hopRelevance=1.0 * kindBoost=1.3 → clamped to 1.0
    result.head.relevance shouldBe 1.0
  }

  it should "penalize File node claims with kindBoost 0.6x" in {
    val seedId = NodeId(UUID.randomUUID())
    val kindMap = Map(seedId -> NodeKind.File)
    val claims = Vector(makeClaim(seedId))
    val result = RelevanceScorer.scoreWithTerms(claims, Set(seedId), Vector.empty, Vector.empty, kindMap)
    // hopRelevance=1.0 * kindBoost=0.6 = 0.6
    result.head.relevance shouldBe 0.6
    result.head.finalScore shouldBe (0.6 * defaultBreakdown.score +- 0.001)
  }

  it should "rank Method claims above File claims for same seed" in {
    val methodId = NodeId(UUID.randomUUID())
    val fileId = NodeId(UUID.randomUUID())
    val kindMap = Map(methodId -> NodeKind.Method, fileId -> NodeKind.File)
    val claims = Vector(makeClaim(fileId), makeClaim(methodId))
    val result = RelevanceScorer.scoreWithTerms(
      claims, Set(methodId, fileId), Vector.empty, Vector.empty, kindMap
    ).sortBy(-_.finalScore)
    result.head.claim.entityId shouldBe methodId
  }

  it should "apply neutral 1.0x kindBoost for Config nodes" in {
    val seedId = NodeId(UUID.randomUUID())
    val kindMap = Map(seedId -> NodeKind.Config)
    val claims = Vector(makeClaim(seedId))
    val result = RelevanceScorer.scoreWithTerms(claims, Set(seedId), Vector.empty, Vector.empty, kindMap)
    result.head.relevance shouldBe 1.0
  }

  it should "use default kindBoost 1.0 when nodeKindMap is empty" in {
    val seedId = NodeId(UUID.randomUUID())
    val claims = Vector(makeClaim(seedId))
    val result = RelevanceScorer.scoreWithTerms(claims, Set(seedId), Vector.empty, Vector.empty, Map.empty)
    result.head.relevance shouldBe 1.0
  }
```

**Step 2: Run tests to verify they fail**

Run: `cd memory-layer && sbt "testOnly ix.memory.context.RelevanceScorerSpec"`
Expected: Compilation failure — `scoreWithTerms` doesn't accept `nodeKindMap` parameter

**Step 3: Write minimal implementation**

Replace `RelevanceScorer.scala`:

```scala
package ix.memory.context

import ix.memory.model._

object RelevanceScorer {
  def score(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge]
  ): Vector[ScoredClaim] =
    scoreWithTerms(claims, seedNodeIds, expandedEdges, Vector.empty, Map.empty)

  def scoreWithTerms(
    claims: Vector[ScoredClaim],
    seedNodeIds: Set[NodeId],
    expandedEdges: Vector[GraphEdge],
    queryTerms: Vector[String],
    nodeKindMap: Map[NodeId, NodeKind] = Map.empty
  ): Vector[ScoredClaim] = {
    val oneHopIds = expandedEdges
      .flatMap(e => Vector(e.src, e.dst))
      .toSet -- seedNodeIds
    val termsLower = queryTerms.map(_.toLowerCase)

    claims.map { sc =>
      val hopRelevance =
        if (seedNodeIds.contains(sc.claim.entityId)) 1.0
        else if (oneHopIds.contains(sc.claim.entityId)) 0.7
        else 0.4

      val fieldLower = sc.claim.statement.toLowerCase
      val exactBoost = if (termsLower.exists(t => fieldLower.contains(t))) 1.2 else 1.0

      val pathLower = sc.claim.provenance.sourceUri.toLowerCase
      val pathBoost = if (termsLower.exists(t => pathLower.contains(t))) 1.1 else 1.0

      val kindBoost = nodeKindMap.get(sc.claim.entityId) match {
        case Some(NodeKind.Method) | Some(NodeKind.Function)  => 1.3
        case Some(NodeKind.Class) | Some(NodeKind.Trait)
           | Some(NodeKind.Object) | Some(NodeKind.Interface) => 1.3
        case Some(NodeKind.Module)                            => 1.2
        case Some(NodeKind.File)                              => 0.6
        case _                                                => 1.0
      }

      val relevance = math.min(1.0, hopRelevance * exactBoost * pathBoost * kindBoost)
      sc.copy(relevance = relevance, finalScore = relevance * sc.confidence.score)
    }
  }
}
```

**Step 4: Run tests to verify they pass**

Run: `cd memory-layer && sbt "testOnly ix.memory.context.RelevanceScorerSpec"`
Expected: All tests PASS

**Step 5: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/context/RelevanceScorer.scala memory-layer/src/test/scala/ix/memory/context/RelevanceScorerSpec.scala
git commit -m "feat: add kindBoost to RelevanceScorer — 1.3x symbols, 0.6x files"
```

---

### Task 5: Wire kindBoost into ContextService

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/context/ContextService.scala:70`

**Step 1: Build the nodeKindMap and pass it to RelevanceScorer**

This is a one-line change. In `ContextService.scala`, at line 70, the current call is:

```scala
      relevant = RelevanceScorer.scoreWithTerms(scored, seeds.map(_.id).toSet, expanded.edges, terms)
```

Change to:

```scala
      nodeKindMap = allNodesAll.map(n => n.id -> n.kind).toMap
      relevant = RelevanceScorer.scoreWithTerms(scored, seeds.map(_.id).toSet, expanded.edges, terms, nodeKindMap)
```

But wait — `allNodesAll` is defined later (line 93). We need `nodeKindMap` from the combined seeds + expanded nodes. Move the node assembly up or compute the map inline. The simplest approach: compute it inline from `seeds` and `expanded.nodes`:

```scala
      nodeKindMap: Map[NodeId, NodeKind] = (seeds ++ expanded.nodes).map(n => n.id -> n.kind).toMap
      relevant = RelevanceScorer.scoreWithTerms(scored, seeds.map(_.id).toSet, expanded.edges, terms, nodeKindMap)
```

**Step 2: Run all tests**

Run: `cd memory-layer && sbt test`
Expected: All tests PASS (ContextServiceSpec may test query flow — verify it still passes)

**Step 3: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/context/ContextService.scala
git commit -m "feat: wire nodeKindMap into RelevanceScorer for symbol preference"
```

---

### Task 6: Improve search — sort symbols first, add attr search

**Files:**
- Modify: `memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala:48-96`

**Step 1: Update the searchNodes AQL query**

Replace the `searchNodes` method body (lines 48-96) with an enhanced version that:
- Adds `attr_matches` subquery searching `TO_STRING(n.attrs)`
- Sorts results: symbol kinds first (function, method, class, trait, object, interface), then others
- Sorts by name within each group

```scala
  override def searchNodes(text: String, limit: Int = 20): IO[Vector[GraphNode]] =
    client.query(
      """LET name_matches = (
        |  FOR n IN nodes
        |    FILTER CONTAINS(LOWER(n.name), LOWER(@text))
        |      AND n.deleted_rev == null
        |    RETURN DISTINCT n.logical_id
        |)
        |
        |LET provenance_matches = (
        |  FOR n IN nodes
        |    FILTER CONTAINS(LOWER(n.provenance.source_uri), LOWER(@text))
        |      AND n.deleted_rev == null
        |    RETURN DISTINCT n.logical_id
        |)
        |
        |LET claim_matches = (
        |  FOR c IN claims
        |    FILTER c.deleted_rev == null
        |      AND (
        |        CONTAINS(LOWER(c.field), LOWER(@text))
        |        OR CONTAINS(LOWER(TO_STRING(c.value)), LOWER(@text))
        |      )
        |    RETURN DISTINCT c.entity_id
        |)
        |
        |LET decision_matches = (
        |  FOR n IN nodes
        |    FILTER n.kind == "decision"
        |      AND n.deleted_rev == null
        |      AND (
        |        CONTAINS(LOWER(TO_STRING(n.attrs.title)), LOWER(@text))
        |        OR CONTAINS(LOWER(TO_STRING(n.attrs.rationale)), LOWER(@text))
        |      )
        |    RETURN DISTINCT n.logical_id
        |)
        |
        |LET attr_matches = (
        |  FOR n IN nodes
        |    FILTER n.deleted_rev == null
        |      AND CONTAINS(LOWER(TO_STRING(n.attrs)), LOWER(@text))
        |    RETURN DISTINCT n.logical_id
        |)
        |
        |LET all_ids = UNION_DISTINCT(name_matches, provenance_matches, claim_matches, decision_matches, attr_matches)
        |
        |FOR id IN all_ids
        |  FOR n IN nodes
        |    FILTER n.logical_id == id AND n.deleted_rev == null
        |  LET symbol_priority = n.kind IN ["function", "method", "class", "trait", "object", "interface"] ? 0 : 1
        |  SORT symbol_priority ASC, n.name ASC
        |  LIMIT @limit
        |  RETURN n""".stripMargin,
      Map(
        "text"   -> text.asInstanceOf[AnyRef],
        "limit"  -> Int.box(limit).asInstanceOf[AnyRef]
      )
    ).map(_.flatMap(parseNode).toVector)
```

**Step 2: Run all tests**

Run: `cd memory-layer && sbt test`
Expected: All tests PASS. The search tests in RoutesSpec/EndToEndSpec should not be affected by the added subquery and sort.

**Step 3: Commit**

```bash
git add memory-layer/src/main/scala/ix/memory/db/ArangoGraphQueryApi.scala
git commit -m "feat: search sorts symbols first, adds attr search for signatures"
```

---

### Task 7: Run full test suite and verify no regressions

**Step 1: Run all tests**

Run: `cd memory-layer && sbt test`
Expected: All tests PASS

**Step 2: Verify compilation**

Run: `cd memory-layer && sbt compile`
Expected: No warnings about exhaustive match (the new NodeKind cases must be handled in the encoder pattern match)

**Step 3: If any test failures, fix them**

Common issues to watch for:
- `ModelSpec` — the NodeKind list must include all 16 variants
- `TypeScriptParserSpec` — existing tests that check `NodeKind.Class` for interfaces or `NodeKind.Function` for methods must be updated
- `ContextServiceSpec` — if it constructs `RelevanceScorer.scoreWithTerms` calls directly, the new `nodeKindMap` parameter has a default value so it shouldn't break
- `RoutesSpec` / `EndToEndSpec` — integration tests that assert on node kinds in API responses may need updating

**Step 4: Commit any fixes**

```bash
git add -A
git commit -m "fix: update tests for new NodeKind variants"
```

---

## Dependency Graph

```
Task 1 (NodeKinds)
  ├── Task 2 (ScalaParser) ──────┐
  ├── Task 3 (TypeScriptParser) ─┼── Task 4 (RelevanceScorer) ── Task 5 (ContextService) ── Task 7 (Full test)
  └── Task 6 (Search) ──────────┘
```

Tasks 2, 3, and 6 can run in parallel after Task 1.
Task 4 can run after Task 1 (doesn't depend on parser changes).
Task 5 depends on Task 4.
Task 7 runs last.
