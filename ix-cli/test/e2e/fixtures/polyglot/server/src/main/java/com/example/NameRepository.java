package com.example;

import java.util.ArrayList;
import java.util.List;

public class NameRepository {
    private final List<String> names = new ArrayList<>();

    public void add(String name) {
        names.add(name);
    }

    public List<String> all() {
        return new ArrayList<>(names);
    }
}
