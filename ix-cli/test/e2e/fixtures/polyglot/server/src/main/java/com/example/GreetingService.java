package com.example;

import java.util.List;
import java.util.stream.Collectors;

public class GreetingService {
    private final Greeter greeter;
    private final NameRepository repository;

    public GreetingService(Greeter greeter, NameRepository repository) {
        this.greeter = greeter;
        this.repository = repository;
    }

    public void register(String name) {
        repository.add(name);
    }

    public List<String> greetAll() {
        return repository.all().stream().map(greeter::greet).collect(Collectors.toList());
    }
}
