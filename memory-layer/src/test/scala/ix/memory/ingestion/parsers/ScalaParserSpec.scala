package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import ix.memory.ingestion.ParsedRelationship
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

  it should "create CONTAINS relationships from file to types" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val defines = result.relationships.filter(_.predicate == "CONTAINS")
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

  // --- Symbol span tests ---

  it should "compute lineStart and lineEnd for trait definitions" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val tr = result.entities.find(e => e.name == "ConfidenceScorer" && e.kind == NodeKind.Trait).get
    tr.lineStart should be >= 1
    tr.lineEnd should be > tr.lineStart
  }

  it should "compute lineStart and lineEnd for class definitions" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val cls = result.entities.find(e => e.name == "ConfidenceScorerImpl" && e.kind == NodeKind.Class).get
    cls.lineStart should be >= 1
    cls.lineEnd should be > cls.lineStart
  }

  it should "compute lineStart and lineEnd for object definitions" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val obj = result.entities.find(e => e.name == "ConfidenceScorerImpl" && e.kind == NodeKind.Object).get
    obj.lineStart should be >= 1
    obj.lineEnd should be > obj.lineStart
  }

  // --- EXTENDS edge tests ---

  it should "extract EXTENDS from class declaration" in {
    val source = """class MyService extends BaseService {
      |  def run(): Unit = {}
      |}""".stripMargin
    val result = parser.parse("Service.scala", source)
    val extends_ = result.relationships.filter(_.predicate == "EXTENDS")
    extends_ should have length 1
    extends_.head.srcName shouldBe "MyService"
    extends_.head.dstName shouldBe "BaseService"
  }

  it should "extract EXTENDS from case class" in {
    val source = """sealed trait Event
      |case class Created(id: String) extends Event""".stripMargin
    val result = parser.parse("Event.scala", source)
    val extends_ = result.relationships.filter(_.predicate == "EXTENDS")
    extends_.map(_.srcName) should contain ("Created")
    extends_.filter(_.srcName == "Created").head.dstName shouldBe "Event"
  }

  it should "extract EXTENDS from case object" in {
    val source = """sealed trait Color
      |case object Red extends Color
      |case object Blue extends Color""".stripMargin
    val result = parser.parse("Color.scala", source)
    val extends_ = result.relationships.filter(_.predicate == "EXTENDS")
    extends_ should have length 2
    extends_.map(_.srcName) should contain allOf ("Red", "Blue")
    extends_.foreach(_.dstName shouldBe "Color")
  }

  it should "extract EXTENDS from object" in {
    val source = """object Routes extends BaseRoutes {
      |  def apply() = {}
      |}""".stripMargin
    val result = parser.parse("Routes.scala", source)
    val extends_ = result.relationships.filter(_.predicate == "EXTENDS")
    extends_.head.srcName shouldBe "Routes"
    extends_.head.dstName shouldBe "BaseRoutes"
  }

  // --- Nested CONTAINS tests ---

  it should "create CONTAINS from enclosing object to nested case objects" in {
    val source = """sealed trait NodeKind
      |object NodeKind {
      |  case object Module extends NodeKind
      |  case object File extends NodeKind
      |}""".stripMargin
    val result = parser.parse("Node.scala", source)
    val contains = result.relationships.filter(_.predicate == "CONTAINS")
    contains should contain (ParsedRelationship("NodeKind", "Module", "CONTAINS"))
    contains should contain (ParsedRelationship("NodeKind", "File", "CONTAINS"))
    contains should not contain (ParsedRelationship("Node.scala", "Module", "CONTAINS"))
  }

  it should "create CONTAINS from enclosing object for nested case classes" in {
    val source = """sealed trait Event
      |object Event {
      |  case class Created(id: String) extends Event
      |  case class Deleted(id: String) extends Event
      |}""".stripMargin
    val result = parser.parse("Event.scala", source)
    val contains = result.relationships.filter(_.predicate == "CONTAINS")
    contains should contain (ParsedRelationship("Event", "Created", "CONTAINS"))
    contains should contain (ParsedRelationship("Event", "Deleted", "CONTAINS"))
  }

  // --- REFERENCES tests ---

  it should "extract REFERENCES from method signatures" in {
    val source = """class Service {
      |  def process(kind: NodeKind, node: GraphNode): Unit = {
      |    println(kind)
      |  }
      |}""".stripMargin
    val result = parser.parse("Service.scala", source)
    val refs = result.relationships.filter(_.predicate == "REFERENCES")
    refs.map(_.dstName) should contain allOf ("NodeKind", "GraphNode")
    refs.map(_.dstName) should not contain ("Unit")
  }

  it should "extract REFERENCES for qualified value access" in {
    val source = """class Handler {
      |  def handle(n: Any): Unit = {
      |    val kind = NodeKind.File
      |    val src = SourceType.Code
      |  }
      |}""".stripMargin
    val result = parser.parse("Handler.scala", source)
    val refs = result.relationships.filter(_.predicate == "REFERENCES")
    refs.map(_.dstName) should contain allOf ("NodeKind", "SourceType")
  }

  it should "compute method spans with valid ranges" in {
    val result = parser.parse("ConfidenceScorer.scala", sampleCode)
    val methods = result.entities.filter(_.kind == NodeKind.Method)
    methods should not be empty
    methods.foreach { m =>
      m.lineStart should be >= 1
      m.lineEnd should be >= m.lineStart
    }
    // computeBase is private to ConfidenceScorerImpl — verify it has a bounded span
    val computeBase = result.entities.find(_.name == "computeBase").get
    computeBase.lineStart should be > 1
    computeBase.lineEnd should be > computeBase.lineStart
  }
}
