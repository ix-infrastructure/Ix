package ix.memory.db.migrations

import com.arcadedb.database.Database
import org.slf4j.LoggerFactory

trait Migration {
  def version: Int
  def description: String
  def migrate(db: Database): Unit
}

object MigrationRunner {
  private val logger = LoggerFactory.getLogger("MigrationRunner")

  val migrations: List[Migration] = List(
    V001_InitialSchema
  )

  def currentSchemaVersion(db: Database): Int = {
    val rs = db.query("sql", "SELECT schemaVersion FROM ix_meta LIMIT 1")
    try {
      if (rs.hasNext) {
        val result = rs.next()
        result.getProperty[Int]("schemaVersion")
      } else 0
    } finally rs.close()
  }

  def targetSchemaVersion: Int = if (migrations.isEmpty) 0 else migrations.map(_.version).max
  def minSupportedSchema: Int = 1
  def maxSupportedSchema: Int = targetSchemaVersion

  def run(db: Database, appVersion: String): Unit = {
    val current = currentSchemaVersion(db)

    if (current > maxSupportedSchema) {
      throw new RuntimeException(
        s"Database schema version $current is newer than this binary supports (max: $maxSupportedSchema). " +
        s"Please run `ix upgrade` to get a compatible version."
      )
    }

    val pending = migrations.filter(_.version > current).sortBy(_.version)
    if (pending.isEmpty) {
      logger.info(s"Schema is up to date at version $current")
      return
    }

    pending.foreach { m =>
      logger.info(s"Running migration V${"%03d".format(m.version)}: ${m.description}")
      db.transaction(() => {
        m.migrate(db)
      })
      logger.info(s"Migration V${"%03d".format(m.version)} complete")
    }

    // Update or insert ix_meta
    val now = java.time.Instant.now().toString
    val newVersion = pending.last.version
    db.transaction(() => {
      // Delete old meta
      db.command("sql", "DELETE FROM ix_meta")
      // Insert new meta
      db.command("sql",
        "INSERT INTO ix_meta SET schemaVersion = ?, appVersion = ?, migratedAt = ?",
        newVersion.asInstanceOf[AnyRef],
        appVersion.asInstanceOf[AnyRef],
        now.asInstanceOf[AnyRef]
      )
    })
    logger.info(s"Schema migrated to version $newVersion")
  }
}
