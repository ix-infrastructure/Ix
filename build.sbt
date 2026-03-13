ThisBuild / scalaVersion := "2.13.16"
ThisBuild / organization := "ix"
ThisBuild / version      := "0.1.0-SNAPSHOT"

lazy val root = (project in file("."))
  .aggregate(memoryLayer)
  .settings(
    name := "ix-memory"
  )

lazy val memoryLayer = (project in file("memory-layer"))
  .settings(
    name := "memory-layer",

    libraryDependencies ++= Seq(
      // Cats Effect
      "org.typelevel"  %% "cats-effect"         % "3.5.4",

      // Http4s
      "org.http4s"     %% "http4s-ember-server" % "0.23.30",
      "org.http4s"     %% "http4s-dsl"          % "0.23.30",
      "org.http4s"     %% "http4s-circe"        % "0.23.30",

      // Circe
      "io.circe"       %% "circe-core"          % "0.14.10",
      "io.circe"       %% "circe-generic"       % "0.14.10",
      "io.circe"       %% "circe-parser"        % "0.14.10",

      // ArangoDB (to be removed after ArcadeDB migration)
      "com.arangodb"   %  "arangodb-java-driver" % "7.12.0",

      // ArcadeDB (embedded graph database)
      "com.arcadedb"   %  "arcadedb-engine"      % "26.1.1",

      // Tree-sitter
      "ch.usi.si.seart" % "java-tree-sitter"    % "1.12.0",

      // Logging
      "org.typelevel"  %% "log4cats-slf4j"      % "2.7.0",
      "ch.qos.logback" %  "logback-classic"     % "1.5.6",

      // Test
      "org.scalatest"  %% "scalatest"                 % "3.2.18" % Test,
      "org.typelevel"  %% "cats-effect-testing-scalatest" % "1.5.0" % Test
    ),

    // Run tests sequentially to avoid ArangoDB write-write conflicts on shared DB
    Test / parallelExecution := false,

    // Assembly settings
    assembly / mainClass := Some("ix.memory.Main"),
    assembly / assemblyJarName := "ix-memory-layer.jar",
    assembly / assemblyMergeStrategy := {
      case PathList("META-INF", "services", _*)     => MergeStrategy.concat
      case PathList("META-INF", "versions", _*)     => MergeStrategy.first
      case PathList("META-INF", "vertx", _*)        => MergeStrategy.first
      case PathList("META-INF", "native-image", _*) => MergeStrategy.first
      case PathList("META-INF", "MANIFEST.MF")      => MergeStrategy.discard
      case PathList("META-INF", _*)                 => MergeStrategy.discard
      case "module-info.class"                      => MergeStrategy.discard
      case _                                        => MergeStrategy.first
    }
  )
