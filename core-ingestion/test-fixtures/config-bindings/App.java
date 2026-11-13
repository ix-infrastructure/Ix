import picocli.CommandLine.Option;
import org.springframework.web.bind.annotation.*;
import org.springframework.core.env.Environment;
import jakarta.ws.rs.GET;
import jakarta.ws.rs.Path;
class App implements Runnable {
 @Option(names = {"-v", "--verbose"}, defaultValue = "false")
 boolean verbose;
 Environment environment;
 String boot() { return System.getenv("APP_HOST") + environment.getProperty("server.host", "localhost"); }
 @GetMapping("/health/{id}")
 String health() { return "ok"; }
 @RequestMapping(path = "/jobs", method = RequestMethod.POST)
 String jobs() { return "ok"; }
 @GET
 @Path("/items/{id}")
 String item() { return "ok"; }
 public void run() { if (verbose) boot(); }
 String unrelated = "System.getenv(FAKE) --fake /fake";
}
