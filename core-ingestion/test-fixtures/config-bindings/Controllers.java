import org.springframework.web.bind.annotation.*;
@RequestMapping("/api")
class Controller {
  @GetMapping("/health")
  String health() { return "ok"; }
  @PostMapping(path = "/jobs")
  String jobs() { return "ok"; }
  @GetMapping
  String root() { return "ok"; }
}
@RequestMapping(path = {"/v1/", "/v2"})
class Versioned {
  @RequestMapping(value = {"/items", "jobs/"}, method = {RequestMethod.GET, RequestMethod.POST})
  String items() { return "ok"; }
}
class Plain {
  @GetMapping("/health")
  String health() { return "ok"; }
}
