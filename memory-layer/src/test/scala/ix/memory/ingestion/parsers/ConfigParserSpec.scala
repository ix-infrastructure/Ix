package ix.memory.ingestion.parsers

import org.scalatest.flatspec.AnyFlatSpec
import org.scalatest.matchers.should.Matchers

import ix.memory.model.NodeKind

class ConfigParserSpec extends AnyFlatSpec with Matchers {
  val parser = new ConfigParser()

  // --- Worktree tests: dot-path flattening ---

  "ConfigParser" should "parse simple JSON key-value pairs" in {
    val json = """{"name": "ix-memory", "version": "1.0"}"""
    val result = parser.parse("package.json", json)
    val entries = result.entities.filter(_.kind == NodeKind.ConfigEntry)
    val names = entries.map(_.name)
    names should contain("name")
    names should contain("version")
  }

  it should "flatten nested JSON objects into dot-path entries" in {
    val json = """{"mcpServers": {"ix-memory": {"command": "node", "args": ["server.js"]}}, "debug": true}"""
    val result = parser.parse("config.json", json)
    val entries = result.entities.filter(_.kind == NodeKind.ConfigEntry)
    val names = entries.map(_.name)
    names should contain("mcpServers.ix-memory.command")
    names should contain("mcpServers.ix-memory.args[0]")
    names should contain("debug")
    entries.foreach { e =>
      val v = e.attrs.get("value").flatMap(_.asString).getOrElse("")
      v should not be "{"
    }
  }

  it should "flatten nested YAML into dot-path entries" in {
    val yaml = "server:\n  host: localhost\n  port: 8080\ndebug: true"
    val result = parser.parse("config.yaml", yaml)
    val entries = result.entities.filter(_.kind == NodeKind.ConfigEntry)
    val names = entries.map(_.name)
    names should contain("server.host")
    names should contain("server.port")
    names should contain("debug")
  }

  it should "parse simple YAML key-value pairs" in {
    val yaml = "name: my-app\nversion: 2.0\nenabled: true"
    val result = parser.parse("config.yml", yaml)
    val entries = result.entities.filter(_.kind == NodeKind.ConfigEntry)
    entries.map(_.name) should contain allOf ("name", "version", "enabled")
  }

  it should "parse TOML with sections as dot-path entries" in {
    val toml = "[database]\nhost = \"localhost\"\nport = 5432\n\n[server]\nworkers = 4"
    val result = parser.parse("config.toml", toml)
    val entries = result.entities.filter(_.kind == NodeKind.ConfigEntry)
    val names = entries.map(_.name)
    names should contain("database.host")
    names should contain("database.port")
    names should contain("server.workers")
  }

  it should "create a Config file-level entity" in {
    val json = """{"key": "value"}"""
    val result = parser.parse("settings.json", json)
    val configs = result.entities.filter(_.kind == NodeKind.Config)
    configs should have size 1
    configs.head.name shouldBe "settings.json"
  }

  it should "create DEFINES relationships from Config to ConfigEntry" in {
    val json = """{"a": "1", "b": "2"}"""
    val result = parser.parse("app.json", json)
    val defines = result.relationships.filter(_.predicate == "DEFINES")
    defines should have size 2
    defines.foreach(_.srcName shouldBe "app.json")
  }

  it should "report canParse correctly for config file extensions" in {
    parser.canParse("config.json") shouldBe true
    parser.canParse("config.yaml") shouldBe true
    parser.canParse("config.yml") shouldBe true
    parser.canParse("config.toml") shouldBe true
    parser.canParse("main.py") shouldBe false
    parser.canParse("README.md") shouldBe false
  }

  // --- Existing tests ---

  it should "create a Config entity with format attr for JSON" in {
    val source = """{ "name": "my-app", "version": "1.0.0" }"""
    val result = parser.parse("package.json", source)
    result.entities.exists(e => e.name == "package.json" && e.kind == NodeKind.Config) shouldBe true
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"json\"")
  }

  it should "extract top-level YAML keys" in {
    val source = """endpoint: http://localhost:8090
      |format: text
      |debug: true""".stripMargin
    val result = parser.parse("config.yaml", source)
    result.entities.exists(e => e.name == "endpoint" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "format" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "debug" && e.kind == NodeKind.ConfigEntry) shouldBe true
  }

  it should "skip YAML comment lines" in {
    val source = """# This is a comment
      |name: test
      |# Another comment
      |port: 8080""".stripMargin
    val result = parser.parse("config.yml", source)
    val entryNames = result.entities.filter(_.kind == NodeKind.ConfigEntry).map(_.name)
    entryNames should contain("name")
    entryNames should contain("port")
    entryNames.size shouldBe 2
  }

  it should "set format to yaml for .yaml files" in {
    val result = parser.parse("app.yaml", "key: value")
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"yaml\"")
  }

  it should "set format to yaml for .yml files" in {
    val result = parser.parse("app.yml", "key: value")
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"yaml\"")
  }

  it should "extract TOML keys with section prefix" in {
    val source = """name = "my-app"
      |version = "1.0.0"
      |
      |[database]
      |host = "localhost"
      |port = 5432""".stripMargin
    val result = parser.parse("config.toml", source)
    result.entities.exists(e => e.name == "name" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "version" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "database.host" && e.kind == NodeKind.ConfigEntry) shouldBe true
    result.entities.exists(e => e.name == "database.port" && e.kind == NodeKind.ConfigEntry) shouldBe true
  }

  it should "set format to toml for .toml files" in {
    val result = parser.parse("config.toml", "key = \"value\"")
    val config = result.entities.find(_.kind == NodeKind.Config).get
    config.attrs.get("format").map(_.noSpaces) shouldBe Some("\"toml\"")
  }

  it should "handle empty config files" in {
    val result = parser.parse("empty.json", "")
    result.entities.exists(_.kind == NodeKind.Config) shouldBe true
    result.entities.count(_.kind == NodeKind.ConfigEntry) shouldBe 0
  }

  it should "store the value in ConfigEntry attrs" in {
    val source = "port: 8080"
    val result = parser.parse("config.yaml", source)
    val entry = result.entities.find(e => e.name == "port" && e.kind == NodeKind.ConfigEntry)
    entry shouldBe defined
    entry.get.attrs.get("value").map(_.noSpaces) shouldBe Some("\"8080\"")
  }
}
