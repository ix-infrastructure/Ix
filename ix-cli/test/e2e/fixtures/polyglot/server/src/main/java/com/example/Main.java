package com.example;

public class Main {
    public static void main(String[] args) {
        GreetingService service = new GreetingService(new Greeter("Hello"), new NameRepository());
        service.register("Ada");
        service.register("Grace");
        for (String line : service.greetAll()) {
            System.out.println(line);
        }
    }
}
