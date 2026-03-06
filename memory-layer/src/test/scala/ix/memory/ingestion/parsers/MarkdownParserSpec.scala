package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers
import io.circe.Json

import ix.memory.model.NodeKind

class MarkdownParserSpec extends AnyFlatSpec with Matchers {
  val parser = new MarkdownParser()

  private def strAttr(attrs: Map[String, Json], key: String): Option[String] =
    attrs.get(key).flatMap(_.asString)

  private def intAttr(attrs: Map[String, Json], key: String): Option[Int] =
    attrs.get(key).flatMap(_.asNumber).flatMap(_.toInt)

  // --- Worktree tests: section content, title attr, 2000-char limit ---

  "MarkdownParser" should "extract headings as Doc entities" in {
    val md = "# Introduction\n\nSome text\n\n## Details\n\nMore text\n"
    val result = parser.parse("readme.md", md)
    val names = result.entities.map(_.name)
    names should contain("Introduction")
    names should contain("Details")
  }

  it should "create a File entity for the document" in {
    val md = "# Title\n\nContent\n"
    val result = parser.parse("test.md", md)
    val file = result.entities.find(_.name == "test.md")
    file shouldBe defined
  }

  it should "create CONTAINS relationships from file to sections" in {
    val md = "# Title\n\nContent\n\n## Sub\n\nMore\n"
    val result = parser.parse("test.md", md)
    val contains = result.relationships.filter(_.predicate == "CONTAINS")
    contains.map(_.srcName) should contain only "test.md"
    contains.map(_.dstName) should contain allOf ("Title", "Sub")
  }

  it should "store full section content up to 2000 chars" in {
    val longContent = "word " * 200  // 1000 chars
    val md = s"# Title\n\n$longContent\n\n## Next"
    val result = parser.parse("long.md", md)
    val titleDoc = result.entities.find(_.name == "Title").get
    val content = strAttr(titleDoc.attrs, "content").get
    content.length should be > 200
  }

  it should "store heading title as separate attr" in {
    val md = "# My Title\n\nSome content\n"
    val result = parser.parse("test.md", md)
    val doc = result.entities.find(_.name == "My Title").get
    strAttr(doc.attrs, "title") shouldBe Some("My Title")
  }

  it should "truncate content at 2000 chars" in {
    val longContent = "a" * 3000
    val md = s"# Big Section\n\n$longContent\n"
    val result = parser.parse("big.md", md)
    val doc = result.entities.find(_.name == "Big Section").get
    val content = strAttr(doc.attrs, "content").get
    content.length shouldBe 2000
  }

  it should "include level attr for headings" in {
    val md = "## Level Two\n\nText\n"
    val result = parser.parse("test.md", md)
    val doc = result.entities.find(_.name == "Level Two").get
    intAttr(doc.attrs, "level") shouldBe Some(2)
  }

  // --- Existing tests: basic structure, empty files ---

  it should "create a File entity with language=markdown" in {
    val result = parser.parse("README.md", "# Hello")
    result.entities.exists(e => e.name == "README.md" && e.kind == NodeKind.File) shouldBe true
    val file = result.entities.find(_.kind == NodeKind.File).get
    file.attrs.get("language").map(_.noSpaces) shouldBe Some("\"markdown\"")
  }

  it should "extract headers as Doc nodes" in {
    val source = """# Overview
      |Some intro text.
      |
      |## Architecture
      |Details about architecture.
      |
      |## API Design
      |Details about API.""".stripMargin
    val result = parser.parse("design.md", source)
    result.entities.exists(e => e.name == "Overview" && e.kind == NodeKind.Doc) shouldBe true
    result.entities.exists(e => e.name == "Architecture" && e.kind == NodeKind.Doc) shouldBe true
    result.entities.exists(e => e.name == "API Design" && e.kind == NodeKind.Doc) shouldBe true
  }

  it should "store the heading level in attrs" in {
    val source = """# Level 1
      |## Level 2
      |### Level 3""".stripMargin
    val result = parser.parse("doc.md", source)
    val h1 = result.entities.find(_.name == "Level 1").get
    val h2 = result.entities.find(_.name == "Level 2").get
    val h3 = result.entities.find(_.name == "Level 3").get
    h1.attrs.get("level").flatMap(_.asNumber).flatMap(_.toInt) shouldBe Some(1)
    h2.attrs.get("level").flatMap(_.asNumber).flatMap(_.toInt) shouldBe Some(2)
    h3.attrs.get("level").flatMap(_.asNumber).flatMap(_.toInt) shouldBe Some(3)
  }

  it should "extract content from section body" in {
    val source = """# Introduction
      |This is the introduction to the project.
      |It explains the main goals.""".stripMargin
    val result = parser.parse("readme.md", source)
    val intro = result.entities.find(_.name == "Introduction").get
    val content = intro.attrs.get("content").flatMap(_.asString).getOrElse("")
    content should include("introduction")
  }

  it should "handle empty markdown files" in {
    val result = parser.parse("empty.md", "")
    result.entities.exists(_.kind == NodeKind.File) shouldBe true
    result.entities.count(_.kind == NodeKind.Doc) shouldBe 0
  }

  it should "handle markdown with no headers" in {
    val source = "Just some text with no headers."
    val result = parser.parse("notes.md", source)
    result.entities.count(_.kind == NodeKind.Doc) shouldBe 0
    result.relationships shouldBe empty
  }

  it should "handle sibling sections at the same level" in {
    val source = """# Main
      |## Section A
      |Content A
      |## Section B
      |Content B""".stripMargin
    val result = parser.parse("doc.md", source)
    // Both should be CONTAINS'd by file
    result.relationships.exists(r => r.srcName == "doc.md" && r.dstName == "Section A") shouldBe true
    result.relationships.exists(r => r.srcName == "doc.md" && r.dstName == "Section B") shouldBe true
  }
}
