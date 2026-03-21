package ix.memory.ingestion.parsers

import ix.memory.ingestion.{Fingerprint, Parser, ParseResult, ParsedEntity, ParsedRelationship}
import ix.memory.model.NodeKind
import io.circe.Json
import org.treesitter.{TSNode, TreeSitterGo}

/**
 * Tree-sitter AST-based Go parser with regex fallback.
 * Extracts packages, functions, methods, structs, interfaces, type aliases,
 * const/var declarations, imports, call edges, and struct embedding (EXTENDS).
 */
class TreeSitterGoParser extends Parser {

  private val regexFallback = new GoParser()

  def parse(fileName: String, source: String): ParseResult = {
    try treeSitterParse(fileName, source)
    catch { case _: Throwable => regexFallback.parse(fileName, source) }
  }

  private def treeSitterParse(fileName: String, source: String): ParseResult = {
    TreeSitterUtils.withParse(new TreeSitterGo(), source) { root =>
      val ctx = new GoExtractionContext(fileName, source, root)
      ctx.result()
    }
  }

  // -------------------------------------------------------------------------
  // Extraction context
  // -------------------------------------------------------------------------

  private class GoExtractionContext(
    fileName: String,
    source: String,
    root: TSNode
  ) {
    import TreeSitterUtils._

    var entities      = Vector.empty[ParsedEntity]
    var relationships = Vector.empty[ParsedRelationship]

    private val lines = source.split("\n", -1)

    // Initialize with file entity
    entities = entities :+ ParsedEntity(
      name      = fileName,
      kind      = NodeKind.File,
      attrs     = Map("language" -> Json.fromString("go")),
      lineStart = 1,
      lineEnd   = lines.length
    )

    // Walk the program
    walkProgram(root)

    def result(): ParseResult = ParseResult(entities, relationships)

    private def walkProgram(node: TSNode): Unit = {
      for (child <- namedChildren(node)) {
        child.getType() match {
          case "package_clause" =>
            handlePackageClause(child)

          case "import_declaration" =>
            handleImportDeclaration(child)

          case "function_declaration" =>
            handleFunctionDeclaration(child)

          case "method_declaration" =>
            handleMethodDeclaration(child)

          case "type_declaration" =>
            handleTypeDeclaration(child)

          case "const_declaration" =>
            handleConstDeclaration(child)

          case "var_declaration" =>
            handleVarDeclaration(child)

          case _ =>
            // Ignore other top-level nodes (comments, etc.)
        }
      }
    }

    // --- Package handling ---

    private def handlePackageClause(node: TSNode): Unit = {
      fieldChild(node, "name").orElse(findChild(node, "package_identifier")).foreach { nameNode =>
        val pkgName = nodeText(nameNode, source)
        // Set package as attribute on the File entity
        entities = entities.map { e =>
          if (e.name == fileName && e.kind == NodeKind.File) {
            e.copy(attrs = e.attrs + ("package" -> Json.fromString(pkgName)))
          } else e
        }
      }
    }

    // --- Import handling ---

    private def handleImportDeclaration(node: TSNode): Unit = {
      // Single import: import "fmt"
      findChild(node, "import_spec").foreach(handleImportSpec)

      // Grouped import: import ( "fmt"; "os" )
      findChild(node, "import_spec_list").foreach { specList =>
        for (spec <- childrenOfType(specList, "import_spec")) {
          handleImportSpec(spec)
        }
      }
    }

    private def handleImportSpec(spec: TSNode): Unit = {
      // import_spec has optional name (alias) and path (interpreted_string_literal)
      val pathOpt = fieldChild(spec, "path")
        .orElse(findChild(spec, "interpreted_string_literal"))
        .map(n => nodeText(n, source).stripPrefix("\"").stripSuffix("\""))

      pathOpt.foreach { importPath =>
        val aliasOpt = fieldChild(spec, "name")
          .map(n => nodeText(n, source))

        val entityName = aliasOpt match {
          case Some(".") => importPath  // dot import
          case Some("_") => importPath  // side-effect import
          case Some(alias) => alias     // named import
          case None => importPath       // bare import
        }

        if (!entities.exists(e => e.name == importPath && e.kind == NodeKind.Module)) {
          entities = entities :+ ParsedEntity(
            name      = importPath,
            kind      = NodeKind.Module,
            attrs     = Map.empty,
            lineStart = lineStart(spec),
            lineEnd   = lineEnd(spec)
          )
        }
        relationships = relationships :+ ParsedRelationship(fileName, importPath, "IMPORTS")
      }
    }

    // --- Function handling ---

    private def handleFunctionDeclaration(node: TSNode): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { funcName =>
        val start = lineStart(node)
        val end = lineEnd(node)
        val sig = extractFirstLine(node).replaceAll("""\s*\{\s*$""", "").trim.take(120)
        val bodyText = nodeText(node, source)
        val fp = Fingerprint.compute(sig, bodyText)
        val exported = funcName.nonEmpty && funcName.head.isUpper

        entities = entities :+ ParsedEntity(
          name      = funcName,
          kind      = NodeKind.Function,
          attrs     = Map(
            "language"   -> Json.fromString("go"),
            "summary"    -> Json.fromString(sig),
            "signature"  -> Json.fromString(sig),
            "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
            "exported"   -> Json.fromBoolean(exported)
          ),
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )
        relationships = relationships :+ ParsedRelationship(fileName, funcName, "CONTAINS")

        // Extract calls from function body
        fieldChild(node, "body").foreach { body =>
          extractCallsFromBody(body, funcName)
        }
      }
    }

    // --- Method handling ---

    private def handleMethodDeclaration(node: TSNode): Unit = {
      val nameOpt = extractName(node, source)
      nameOpt.foreach { methodName =>
        val start = lineStart(node)
        val end = lineEnd(node)
        val sig = extractFirstLine(node).replaceAll("""\s*\{\s*$""", "").trim.take(120)
        val bodyText = nodeText(node, source)
        val fp = Fingerprint.compute(sig, bodyText)
        val exported = methodName.nonEmpty && methodName.head.isUpper

        // Extract receiver type name
        val receiverType = fieldChild(node, "receiver")
          .orElse(findChild(node, "parameter_list"))
          .flatMap(extractReceiverType)

        val attrs = Map(
          "language"   -> Json.fromString("go"),
          "summary"    -> Json.fromString(sig),
          "signature"  -> Json.fromString(sig),
          "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
          "exported"   -> Json.fromBoolean(exported)
        ) ++ receiverType.map(r => "receiver" -> Json.fromString(r))

        entities = entities :+ ParsedEntity(
          name      = methodName,
          kind      = NodeKind.Method,
          attrs     = attrs,
          lineStart = start,
          lineEnd   = end,
          contentFingerprint = Some(fp)
        )

        // Method belongs to receiver type, not file
        val containsSrc = receiverType.getOrElse(fileName)
        relationships = relationships :+ ParsedRelationship(containsSrc, methodName, "CONTAINS")

        // Extract calls from method body
        fieldChild(node, "body").foreach { body =>
          extractCallsFromBody(body, methodName)
        }
      }
    }

    private def extractReceiverType(paramList: TSNode): Option[String] = {
      // The receiver parameter list contains a single parameter_declaration
      // e.g., (r *Receiver) or (r Receiver)
      val params = namedChildren(paramList)
      params.headOption.flatMap { param =>
        // Look for type_identifier or pointer_type → type_identifier
        val typeNode = fieldChild(param, "type").getOrElse(param)
        extractTypeName(typeNode)
      }
    }

    private def extractTypeName(node: TSNode): Option[String] = {
      node.getType() match {
        case "type_identifier" =>
          Some(nodeText(node, source))
        case "pointer_type" =>
          // *Type — recurse to get the type name
          namedChildren(node).headOption.flatMap(extractTypeName)
        case "parameter_declaration" =>
          // Get the type field
          fieldChild(node, "type").flatMap(extractTypeName)
        case "generic_type" =>
          // Type[T] — extract the base type
          fieldChild(node, "type").flatMap(extractTypeName)
        case _ =>
          // Fallback: try to find a type_identifier descendant
          findChild(node, "type_identifier").map(n => nodeText(n, source))
      }
    }

    // --- Type declaration handling ---

    private def handleTypeDeclaration(node: TSNode): Unit = {
      // Single type: type Foo struct { ... }
      findChild(node, "type_spec").foreach(handleTypeSpec)

      // Grouped type: type ( Foo struct {}; Bar interface {} )
      for (child <- namedChildren(node)) {
        if (child.getType() == "type_spec") {
          handleTypeSpec(child)
        }
      }
    }

    private def handleTypeSpec(spec: TSNode): Unit = {
      val nameOpt = extractName(spec, source)
      nameOpt.foreach { typeName =>
        val start = lineStart(spec)
        val end = lineEnd(spec)
        val exported = typeName.nonEmpty && typeName.head.isUpper
        val bodyText = nodeText(spec, source)

        // Determine the type kind from the type expression
        val typeNode = fieldChild(spec, "type")
        val typeKind = typeNode.map(_.getType()).getOrElse("")

        typeKind match {
          case "struct_type" =>
            val sig = extractFirstLine(spec).replaceAll("""\s*\{\s*$""", "").trim.take(120)
            val fp = Fingerprint.compute(sig, bodyText)
            entities = entities :+ ParsedEntity(
              name      = typeName,
              kind      = NodeKind.Class,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "go_kind"    -> Json.fromString("struct"),
                "signature"  -> Json.fromString(sig),
                "summary"    -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = start,
              lineEnd   = end,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, typeName, "CONTAINS")

            // Extract struct embedding (EXTENDS)
            typeNode.foreach(extractStructEmbedding(_, typeName))

          case "interface_type" =>
            val sig = extractFirstLine(spec).replaceAll("""\s*\{\s*$""", "").trim.take(120)
            val fp = Fingerprint.compute(sig, bodyText)
            entities = entities :+ ParsedEntity(
              name      = typeName,
              kind      = NodeKind.Interface,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "go_kind"    -> Json.fromString("interface"),
                "signature"  -> Json.fromString(sig),
                "summary"    -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = start,
              lineEnd   = end,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, typeName, "CONTAINS")

            // Extract interface embedding
            typeNode.foreach(extractInterfaceEmbedding(_, typeName))

          case _ =>
            // Type alias (type Foo = Bar) or named type (type Foo int)
            val isAlias = allChildren(spec).exists(c => nodeText(c, source) == "=")
            val goKind = if (isAlias) "type_alias" else "named_type"
            val sig = nodeText(spec, source).trim.take(120)
            val fp = Fingerprint.compute(sig, bodyText)

            entities = entities :+ ParsedEntity(
              name      = typeName,
              kind      = NodeKind.Class,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "go_kind"    -> Json.fromString(goKind),
                "signature"  -> Json.fromString(sig),
                "summary"    -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = start,
              lineEnd   = end,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, typeName, "CONTAINS")
        }
      }
    }

    private def extractStructEmbedding(structType: TSNode, typeName: String): Unit = {
      // Walk field_declaration_list for embedded fields (no field name)
      findChild(structType, "field_declaration_list").foreach { fieldList =>
        for (field <- childrenOfType(fieldList, "field_declaration")) {
          // An embedded field has a type but no name field
          val hasName = fieldChild(field, "name").isDefined
          if (!hasName) {
            // The type is the embedded type
            fieldChild(field, "type").foreach { typeNode =>
              extractTypeName(typeNode).foreach { embeddedName =>
                if (embeddedName != typeName && !GoBuiltins.contains(embeddedName)) {
                  relationships = relationships :+ ParsedRelationship(typeName, embeddedName, "EXTENDS")
                }
              }
            }
          }
        }
      }
    }

    private def extractInterfaceEmbedding(ifaceType: TSNode, typeName: String): Unit = {
      // Walk interface body for bare type identifiers (embedded interfaces)
      for (child <- namedChildren(ifaceType)) {
        child.getType() match {
          case "type_identifier" =>
            val embeddedName = nodeText(child, source)
            if (embeddedName != typeName && !GoBuiltins.contains(embeddedName)) {
              relationships = relationships :+ ParsedRelationship(typeName, embeddedName, "EXTENDS")
            }
          case "qualified_type" =>
            // pkg.Type embedded
            fieldChild(child, "name")
              .orElse(namedChildren(child).lastOption)
              .foreach { nameNode =>
                val embeddedName = nodeText(nameNode, source)
                if (embeddedName != typeName) {
                  relationships = relationships :+ ParsedRelationship(typeName, embeddedName, "EXTENDS")
                }
              }
          case _ => // method specs, etc. — skip
        }
      }
    }

    // --- Const/Var handling ---

    private def handleConstDeclaration(node: TSNode): Unit = {
      // Single const or grouped const ( ... )
      val specs = childrenOfType(node, "const_spec")
      if (specs.isEmpty) {
        // May have a single const_spec as direct structure
        handleConstOrVarSpecs(namedChildren(node).filter(_.getType() == "const_spec"), "const")
      } else {
        handleConstOrVarSpecs(specs, "const")
      }
    }

    private def handleVarDeclaration(node: TSNode): Unit = {
      val specs = childrenOfType(node, "var_spec")
      if (specs.isEmpty) {
        handleConstOrVarSpecs(namedChildren(node).filter(_.getType() == "var_spec"), "var")
      } else {
        handleConstOrVarSpecs(specs, "var")
      }
    }

    private def handleConstOrVarSpecs(specs: Vector[TSNode], declKind: String): Unit = {
      for (spec <- specs) {
        // Each spec may have multiple names: const a, b = 1, 2
        val names = fieldChild(spec, "name")
          .map(Vector(_))
          .getOrElse(childrenOfType(spec, "identifier"))

        for (nameNode <- names) {
          val varName = nodeText(nameNode, source)
          if (varName.nonEmpty && varName != "_") {
            val start = lineStart(spec)
            val end = lineEnd(spec)
            val exported = varName.head.isUpper
            val sig = nodeText(spec, source).trim.take(120)
            val fp = Fingerprint.compute(sig, sig)

            entities = entities :+ ParsedEntity(
              name      = varName,
              kind      = NodeKind.Variable,
              attrs     = Map(
                "language"   -> Json.fromString("go"),
                "go_kind"    -> Json.fromString(declKind),
                "signature"  -> Json.fromString(sig),
                "visibility" -> Json.fromString(if (exported) "exported" else "unexported"),
                "exported"   -> Json.fromBoolean(exported)
              ),
              lineStart = start,
              lineEnd   = end,
              contentFingerprint = Some(fp)
            )
            relationships = relationships :+ ParsedRelationship(fileName, varName, "CONTAINS")
          }
        }
      }
    }

    // --- CALLS extraction ---

    private def extractCallsFromBody(bodyNode: TSNode, callerName: String): Unit = {
      val seen = scala.collection.mutable.Set.empty[String]
      val callExprs = collectDescendants(bodyNode, _.getType() == "call_expression")

      for (callExpr <- callExprs) {
        fieldChild(callExpr, "function").foreach { funcNode =>
          val callee = resolveCalleeName(funcNode)
          callee.foreach { name =>
            if (name != callerName && !GoBuiltins.contains(name) &&
                !GoKeywords.contains(name) && !seen.contains(name) && name != fileName) {
              seen += name
              relationships = relationships :+ ParsedRelationship(callerName, name, "CALLS")
            }
          }
        }
      }
    }

    private def resolveCalleeName(funcNode: TSNode): Option[String] = {
      funcNode.getType() match {
        case "identifier" =>
          Some(nodeText(funcNode, source))
        case "selector_expression" =>
          // e.g., pkg.Func() or obj.Method() — extract the field (rightmost)
          fieldChild(funcNode, "field").map(n => nodeText(n, source))
        case "call_expression" =>
          // Chained calls — recurse
          fieldChild(funcNode, "function").flatMap(resolveCalleeName)
        case "parenthesized_expression" =>
          // (func)() — recurse into the inner expression
          namedChildren(funcNode).headOption.flatMap(resolveCalleeName)
        case _ =>
          None
      }
    }

    // --- Helpers ---

    private def extractFirstLine(node: TSNode): String = {
      val text = nodeText(node, source)
      text.split("\n").head
    }
  }

  // --- Shared constants ---

  private val GoKeywords: Set[String] = Set(
    "break", "case", "chan", "const", "continue", "default", "defer",
    "else", "fallthrough", "for", "func", "go", "goto", "if",
    "import", "interface", "map", "package", "range", "return",
    "select", "struct", "switch", "type", "var"
  )

  private val GoBuiltins: Set[String] = Set(
    "make", "len", "cap", "append", "copy", "close", "delete",
    "complex", "real", "imag", "new", "panic", "recover",
    "print", "println", "error", "string", "int", "float64",
    "bool", "byte", "rune", "nil", "true", "false", "iota",
    "int8", "int16", "int32", "int64",
    "uint", "uint8", "uint16", "uint32", "uint64", "uintptr",
    "float32", "complex64", "complex128", "any", "comparable"
  )
}
