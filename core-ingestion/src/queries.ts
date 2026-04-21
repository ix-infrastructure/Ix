import { SupportedLanguages } from './languages.js';

/* 
 * Tree-sitter queries for extracting code definitions.
 * 
 * Note: Different grammars (typescript vs tsx vs javascript) may have
 * slightly different node types. These queries are designed to be 
 * compatible with the standard tree-sitter grammars.
 */

// TypeScript queries - works with tree-sitter-typescript
export const TYPESCRIPT_QUERIES = `
(class_declaration
  name: (type_identifier) @name) @definition.class

(interface_declaration
  name: (type_identifier) @name) @definition.interface

(function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

(import_statement
  source: (string) @import.source) @import

; Re-export statements: export { X } from './y'
(export_statement
  source: (string) @import.source) @import

; Dynamic import with string literal: import('./foo') or await import('./foo')
(call_expression
  function: (import)
  arguments: (arguments (string) @import.source)) @import

(call_expression
  function: (identifier) @call.name) @call

(call_expression
  function: (member_expression
    property: (property_identifier) @call.name)) @call

; this.method() — capture this as qualifier so index.ts can substitute the enclosing class.
; Analogous to Python's self/cls substitution.
(call_expression
  function: (member_expression
    object: (this) @_qualifier
    property: (property_identifier) @call.name)) @call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @call.name) @call

; Heritage queries - class extends
(class_declaration
  name: (type_identifier) @heritage.class
  (class_heritage
    (extends_clause
      value: (identifier) @heritage.extends))) @heritage

; Heritage queries - class implements interface
(class_declaration
  name: (type_identifier) @heritage.class
  (class_heritage
    (implements_clause
      (type_identifier) @heritage.implements))) @heritage.impl

; Heritage queries - interface extends interface
(interface_declaration
  name: (type_identifier) @heritage.class
  (extends_type_clause
    (type_identifier) @heritage.extends)) @heritage

; Type references — captures types used in annotations/parameters/return types
(type_annotation (type_identifier) @reference.type)
`;

// JavaScript queries - works with tree-sitter-javascript
export const JAVASCRIPT_QUERIES = `
(class_declaration
  name: (identifier) @name) @definition.class

(function_declaration
  name: (identifier) @name) @definition.function

(method_definition
  name: (property_identifier) @name) @definition.method

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

(lexical_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

; var foo = function() {} (CommonJS var declarations)
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (function_expression))) @definition.function

; var foo = () => {} (CommonJS var arrow functions)
(variable_declaration
  (variable_declarator
    name: (identifier) @name
    value: (arrow_function))) @definition.function

; obj.method = function name() {} (prototype/mixin method assignments)
(expression_statement
  (assignment_expression
    left: (member_expression
      property: (property_identifier) @name)
    right: (function_expression))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (arrow_function)))) @definition.function

(export_statement
  declaration: (lexical_declaration
    (variable_declarator
      name: (identifier) @name
      value: (function_expression)))) @definition.function

(import_statement
  source: (string) @import.source) @import

; Re-export statements: export { X } from './y'
(export_statement
  source: (string) @import.source) @import

; Dynamic import with string literal: import('./foo') or await import('./foo')
(call_expression
  function: (import)
  arguments: (arguments (string) @import.source)) @import

; CommonJS require() → IMPORTS
(call_expression
  function: (identifier) @_req
  arguments: (arguments (string) @import.source)
  (#eq? @_req "require")) @import

(call_expression
  function: (identifier) @call.name) @call

(call_expression
  function: (member_expression
    property: (property_identifier) @call.name)) @call

; this.method() — capture this as qualifier so index.ts can substitute the enclosing class.
; Analogous to Python's self/cls substitution.
(call_expression
  function: (member_expression
    object: (this) @_qualifier
    property: (property_identifier) @call.name)) @call

; Constructor calls: new Foo()
(new_expression
  constructor: (identifier) @call.name) @call

; Heritage queries - class extends (JavaScript uses different AST than TypeScript)
; In tree-sitter-javascript, class_heritage directly contains the parent identifier
(class_declaration
  name: (identifier) @heritage.class
  (class_heritage
    (identifier) @heritage.extends)) @heritage
`;

// Python queries - works with tree-sitter-python
export const PYTHON_QUERIES = `
(class_definition
  name: (identifier) @name) @definition.class

(function_definition
  name: (identifier) @name) @definition.function

(import_statement
  name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (dotted_name) @import.source) @import

(import_from_statement
  module_name: (relative_import) @import.source) @import

; from . import utils / from .models import User — capture imported symbol names (relative imports)
(import_from_statement
  module_name: (relative_import)
  name: (dotted_name (identifier) @import.name)) @import.names

; from module import Class — capture imported symbol names (absolute imports)
; e.g. from sqlalchemy.sql.schema import Column → import.name = Column
(import_from_statement
  module_name: (dotted_name)
  name: (dotted_name (identifier) @import.name)) @import.names

(call
  function: (identifier) @call.name) @call

(call
  function: (attribute
    attribute: (identifier) @call.name)) @call

; Attribute calls with object captured as qualifier so Tier-1b resolution can use
; class/module name to break ties (e.g. Session.execute → resolves to Session in
; the importing file).  Emitted alongside the bare-name pattern above so that
; bare-name global fallback still fires when qualifier resolution fails.
(call
  function: (attribute
    object: (identifier) @_qualifier
    attribute: (identifier) @call.name)) @call

; Django ORM manager pattern: Model.objects.method(...)
; Unwinds the intermediate accessor (objects/related_manager/etc.) and captures
; the model class as qualifier, e.g. User.objects.filter(...) → CALLS User.filter.
; This creates cross-file edges between view/form code and model definitions.
(call
  function: (attribute
    object: (attribute
      object: (identifier) @_qualifier
      attribute: (identifier))
    attribute: (identifier) @call.name)) @call

; Chained call pattern: qualifier.method1(...).method2(...)
; Propagates the qualifier from the inner call to the outer, e.g.
; User.filter(...).order_by(...) → CALLS User.order_by.
(call
  function: (attribute
    object: (call
      function: (attribute
        object: (identifier) @_qualifier
        attribute: (identifier)))
    attribute: (identifier) @call.name)) @call

; Heritage queries - Python class inheritance
(class_definition
  name: (identifier) @heritage.class
  superclasses: (argument_list
    (identifier) @heritage.extends)) @heritage

; Type references — captures types used in type annotations / hints
(typed_parameter type: (type (identifier) @reference.type))
(typed_default_parameter type: (type (identifier) @reference.type))

; Class/function references passed as keyword argument values
; e.g. LoginView.as_view(authentication_form=AdminAuthenticationForm, ...)
; Emits a CALLS edge from the enclosing function to the referenced identifier.
(call
  arguments: (argument_list
    (keyword_argument
      value: (identifier) @call.name)))

; Typed parameters: capture name + type together so qualifier substitution can
; map a local variable name to its declared class (e.g. query: Query → 'query' → 'Query').
(function_definition
  parameters: (parameters
    (typed_parameter
      (identifier) @_typed_param_name
      type: (type (identifier) @_typed_param_type)))) @_typed_param_scope

(function_definition
  parameters: (parameters
    (typed_default_parameter
      (identifier) @_typed_param_name
      type: (type (identifier) @_typed_param_type)))) @_typed_param_scope

; Assignment tracking: x = SomeClass() or x = SomeClass(args)
; Maps local variable name → constructor type for untyped-parameter qualifier substitution.
; Only PascalCase RHS names are tracked in TypeScript (constructor convention).
(function_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @_assign_lhs
        right: (call
          function: (identifier) @_assign_rhs_type))))) @_assign_scope

; Assignment tracking: x = Model.objects.method()
; Captures the outermost identifier (model class) for ORM manager patterns.
(function_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @_assign_lhs
        right: (call
          function: (attribute
            object: (attribute
              object: (identifier) @_assign_rhs_type
              attribute: (identifier))
            attribute: (identifier))))))) @_assign_scope

; Assignment tracking: x = module.Class (direct attribute reference, no call)
; Handles variable aliasing like: engineclass = base.Engine
; Combined with direct-call resolution in index.ts, this lets engineclass(...) → Engine(...)
(function_definition
  body: (block
    (expression_statement
      (assignment
        left: (identifier) @_assign_lhs
        right: (attribute
          attribute: (identifier) @_assign_rhs_type))))) @_assign_scope
`;

// Java queries - works with tree-sitter-java
export const JAVA_QUERIES = `
; Classes, Interfaces, Enums, Annotations
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(enum_declaration name: (identifier) @name) @definition.enum
(annotation_type_declaration name: (identifier) @name) @definition.annotation

; Methods & Constructors
(method_declaration name: (identifier) @name) @definition.method
(constructor_declaration name: (identifier) @name) @definition.constructor

; Imports - capture any import declaration child as source
(import_declaration (_) @import.source) @import

; Calls
(method_invocation name: (identifier) @call.name) @call
(method_invocation object: (_) name: (identifier) @call.name) @call

; Constructor calls: new Foo()
(object_creation_expression type: (type_identifier) @call.name) @call

; Heritage - extends class (plain: extends Foo)
(class_declaration name: (identifier) @heritage.class
  (superclass (type_identifier) @heritage.extends)) @heritage

; Heritage - extends class with generics (extends Foo<T>)
(class_declaration name: (identifier) @heritage.class
  (superclass (generic_type (type_identifier) @heritage.extends))) @heritage

; Heritage - implements interfaces (plain: implements Foo)
(class_declaration name: (identifier) @heritage.class
  (super_interfaces (type_list (type_identifier) @heritage.implements))) @heritage.impl

; Heritage - implements interfaces with generics (implements Foo<T>)
(class_declaration name: (identifier) @heritage.class
  (super_interfaces (type_list (generic_type (type_identifier) @heritage.implements)))) @heritage.impl

; Heritage - interface extends interfaces (plain: extends Foo)
(interface_declaration name: (identifier) @heritage.class
  (extends_interfaces (type_list (type_identifier) @heritage.extends))) @heritage

; Heritage - interface extends interfaces with generics (extends Foo<T>)
(interface_declaration name: (identifier) @heritage.class
  (extends_interfaces (type_list (generic_type (type_identifier) @heritage.extends)))) @heritage

; Type references — captures types used in field/param/return-type positions
(field_declaration type: (type_identifier) @reference.type)
(formal_parameter type: (type_identifier) @reference.type)
(local_variable_declaration type: (type_identifier) @reference.type)
(method_declaration type: (type_identifier) @reference.type)
`;

// C queries - works with tree-sitter-c
export const C_QUERIES = `
; Functions (direct declarator)
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function

; Functions returning pointers (pointer_declarator wraps function_declarator)
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

; Functions returning double pointers (nested pointer_declarator)
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @definition.function

; Structs, Unions, Enums, Typedefs
; Only match struct/union with a body to avoid treating forward declarations as definitions
(struct_specifier name: (type_identifier) @name body: (field_declaration_list)) @definition.struct
(union_specifier name: (type_identifier) @name body: (field_declaration_list)) @definition.union
(enum_specifier name: (type_identifier) @name) @definition.enum
(type_definition declarator: (type_identifier) @name) @definition.typedef

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call

; Type references — captures types used in declaration/parameter positions
(declaration type: (type_identifier) @reference.type)
(parameter_declaration type: (type_identifier) @reference.type)
; struct_specifier forms: e.g. "const struct Curl_protocol foo = {...}"
(declaration type: (struct_specifier name: (type_identifier) @reference.type))
(parameter_declaration type: (struct_specifier name: (type_identifier) @reference.type))
`;

// Go queries - works with tree-sitter-go
export const GO_QUERIES = `
; Functions
(function_declaration name: (identifier) @name) @definition.function

; Methods — non-pointer receiver: func (r ReceiverType) Name(...)
; The receiver.type capture lets the parser set container = ReceiverType so that
; qualifiedKey becomes "ReceiverType.Name" instead of bare "Name".
(method_declaration
  receiver: (parameter_list (parameter_declaration
    type: (type_identifier) @receiver.type))
  name: (field_identifier) @name) @definition.method

; Methods — pointer receiver: func (r *ReceiverType) Name(...)
(method_declaration
  receiver: (parameter_list (parameter_declaration
    type: (pointer_type (type_identifier) @receiver.type)))
  name: (field_identifier) @name) @definition.method

; Types
(type_declaration (type_spec name: (type_identifier) @name type: (struct_type))) @definition.struct
(type_declaration (type_spec name: (type_identifier) @name type: (interface_type))) @definition.interface

; Interface method signatures — emits each method inside an interface_type as a method entity.
; @heritage.class = interface name (used as container in index.ts via heritageClassCapture).
; node type is method_elem in tree-sitter-go v0.21+.
(type_declaration
  (type_spec
    name: (type_identifier) @heritage.class
    type: (interface_type
      (method_elem
        name: (field_identifier) @name)))) @definition.method

; Imports
(import_declaration (import_spec name: (package_identifier) @import.alias path: (interpreted_string_literal) @import.source)) @import
(import_declaration (import_spec path: (interpreted_string_literal) @import.source)) @import
(import_declaration (import_spec_list (import_spec path: (interpreted_string_literal) @import.source))) @import
(import_declaration (import_spec_list (import_spec name: (package_identifier) @import.alias path: (interpreted_string_literal) @import.source))) @import

; Struct embedding — value: type Foo struct { Bar }
; NOTE: no @definition.* capture here — if it were present, defCapture fires first and
; the heritage block is never reached (early-exit in the first pass).
; The . anchors require the type_identifier to be the FIRST and ONLY named child of
; field_declaration, distinguishing anonymous embedded fields from named fields like:
;   w Writer  (named field — field_identifier_list precedes type, not matched)
(type_declaration
  (type_spec
    name: (type_identifier) @heritage.class
    type: (struct_type
      (field_declaration_list
        (field_declaration .
          (type_identifier) @heritage.extends .)))))

; Struct embedding — pointer: type Foo struct { *Bar }
; The . anchor requires pointer_type to be the first named child (anonymous embedded).
(type_declaration
  (type_spec
    name: (type_identifier) @heritage.class
    type: (struct_type
      (field_declaration_list
        (field_declaration .
          (pointer_type (type_identifier) @heritage.extends) .)))))

; Calls
(call_expression function: (identifier) @call.name) @call
; Qualified calls: pkg.Func() or localVar.Method() where the operand is a simple
; identifier — capture it as @_qualifier so cross-file resolution uses the fully
; qualified name "scrape.NewManager" instead of bare "NewManager", preventing
; ambiguous same-named symbols in different packages from being collapsed.
(call_expression function: (selector_expression
  operand: (identifier) @_qualifier
  field: (field_identifier) @call.name)) @call
; Chained/complex calls: a.b.Method(), call().Method(), index[i].Method() — the
; operand is not a simple identifier, so emit without qualifier (bare method name).
(call_expression function: (selector_expression
  operand: (selector_expression)
  field: (field_identifier) @call.name)) @call

; Struct literal construction: User{Name: "Alice"}
(composite_literal type: (type_identifier) @call.name) @call

; Type references — captures types used in field/param/return-type positions
(field_declaration type: (type_identifier) @reference.type)
(parameter_declaration type: (type_identifier) @reference.type)
; Return types: in tree-sitter-go, return type is a direct type_identifier child of function/method
(function_declaration result: (type_identifier) @reference.type)
(method_declaration result: (type_identifier) @reference.type)

; Pointer-type variants: e.g. opts *Options, func(*Options) *Result
(field_declaration type: (pointer_type (type_identifier) @reference.type))
(parameter_declaration type: (pointer_type (type_identifier) @reference.type))
(function_declaration result: (pointer_type (type_identifier) @reference.type))
(method_declaration result: (pointer_type (type_identifier) @reference.type))
; Imported/package-qualified type refs: *scheduler.Scheduler, scheduler.Scheduler
(field_declaration type: (qualified_type (type_identifier) @reference.type))
(parameter_declaration type: (qualified_type (type_identifier) @reference.type))
(function_declaration result: (qualified_type (type_identifier) @reference.type))
(method_declaration result: (qualified_type (type_identifier) @reference.type))
(field_declaration type: (pointer_type (qualified_type (type_identifier) @reference.type)))
(parameter_declaration type: (pointer_type (qualified_type (type_identifier) @reference.type)))
(function_declaration result: (pointer_type (qualified_type (type_identifier) @reference.type)))
(method_declaration result: (pointer_type (qualified_type (type_identifier) @reference.type)))
`;

// C++ queries - works with tree-sitter-cpp
export const CPP_QUERIES = `
; Classes, Structs, Namespaces
(class_specifier name: (type_identifier) @name) @definition.class
(struct_specifier name: (type_identifier) @name) @definition.struct
(namespace_definition name: (namespace_identifier) @name) @definition.namespace
(enum_specifier name: (type_identifier) @name) @definition.enum

; Typedefs and unions (common in C-style headers and mixed C/C++ code)
(type_definition declarator: (type_identifier) @name) @definition.typedef
(union_specifier name: (type_identifier) @name) @definition.union

; Macros
(preproc_function_def name: (identifier) @name) @definition.macro
(preproc_def name: (identifier) @name) @definition.macro

; Functions & Methods (direct declarator)
(function_definition declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (_) @receiver.type name: (identifier) @name))) @definition.method

; Functions/methods returning pointers (pointer_declarator wraps function_declarator)
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier scope: (_) @receiver.type name: (identifier) @name)))) @definition.method

; Functions/methods returning double pointers (nested pointer_declarator)
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name)))) @definition.function
(function_definition declarator: (pointer_declarator declarator: (pointer_declarator declarator: (function_declarator declarator: (qualified_identifier scope: (_) @receiver.type name: (identifier) @name))))) @definition.method

; Functions/methods returning references (reference_declarator wraps function_declarator)
(function_definition declarator: (reference_declarator (function_declarator declarator: (identifier) @name))) @definition.function
(function_definition declarator: (reference_declarator (function_declarator declarator: (qualified_identifier scope: (_) @receiver.type name: (identifier) @name)))) @definition.method

; Destructors (destructor_name is distinct from identifier in tree-sitter-cpp)
(function_definition declarator: (function_declarator declarator: (qualified_identifier scope: (_) @receiver.type name: (destructor_name) @name))) @definition.method

; Function declarations / prototypes (common in headers)
(declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.function
(declaration declarator: (pointer_declarator declarator: (function_declarator declarator: (identifier) @name))) @definition.function

; Inline class method declarations (inside class body, no body: void Foo();)
(field_declaration declarator: (function_declarator declarator: (identifier) @name)) @definition.method

; Inline class method definitions (inside class body, with body: void Foo() { ... })
(field_declaration_list
  (function_definition
    declarator: (function_declarator
      declarator: [(field_identifier) (identifier) (operator_name) (destructor_name)] @name)) @definition.method)

; Templates
(template_declaration (class_specifier name: (type_identifier) @name)) @definition.template
(template_declaration (function_definition declarator: (function_declarator declarator: (identifier) @name))) @definition.template

; Includes
(preproc_include path: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (field_expression argument: (identifier) @_qualifier field: (field_identifier) @call.name)) @call
(call_expression function: (qualified_identifier name: (identifier) @call.name)) @call
(call_expression function: (template_function name: (identifier) @call.name)) @call

; Constructor calls: new User()
(new_expression type: (type_identifier) @call.name) @call

; Heritage
(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (type_identifier) @heritage.extends)) @heritage
(class_specifier name: (type_identifier) @heritage.class
  (base_class_clause (access_specifier) (type_identifier) @heritage.extends)) @heritage

; Type references — captures types used in declaration/parameter positions
(declaration type: (type_identifier) @reference.type)
(parameter_declaration type: (type_identifier) @reference.type)

; Typed declarations for qualifier substitution: local vars, fields, params
(declaration
  type: (type_identifier) @_typed_var_type
  declarator: (identifier) @_typed_var_name) @_typed_var_scope
(declaration
  type: (type_identifier) @_typed_var_type
  declarator: (pointer_declarator declarator: (identifier) @_typed_var_name)) @_typed_var_scope
(declaration
  type: (type_identifier) @_typed_var_type
  declarator: (init_declarator declarator: (identifier) @_typed_var_name)) @_typed_var_scope
(declaration
  type: (type_identifier) @_typed_var_type
  declarator: (init_declarator declarator: (pointer_declarator declarator: (identifier) @_typed_var_name))) @_typed_var_scope
(declaration
  type: (type_identifier) @_typed_var_type
  declarator: (reference_declarator (identifier) @_typed_var_name)) @_typed_var_scope
(field_declaration
  type: (type_identifier) @_typed_var_type
  declarator: (field_identifier) @_typed_var_name) @_typed_var_scope
(field_declaration
  type: (type_identifier) @_typed_var_type
  declarator: (pointer_declarator declarator: (field_identifier) @_typed_var_name)) @_typed_var_scope
(parameter_declaration
  type: (type_identifier) @_typed_var_type
  declarator: (identifier) @_typed_var_name) @_typed_var_scope
(parameter_declaration
  type: (type_identifier) @_typed_var_type
  declarator: (pointer_declarator declarator: (identifier) @_typed_var_name)) @_typed_var_scope
`;

// C# queries - works with tree-sitter-c-sharp
export const CSHARP_QUERIES = `
; Types
(class_declaration name: (identifier) @name) @definition.class
(interface_declaration name: (identifier) @name) @definition.interface
(struct_declaration name: (identifier) @name) @definition.struct
(enum_declaration name: (identifier) @name) @definition.enum
(record_declaration name: (identifier) @name) @definition.record
(delegate_declaration name: (identifier) @name) @definition.delegate

; Namespaces (block form and C# 10+ file-scoped form)
(namespace_declaration name: (identifier) @name) @definition.namespace
(namespace_declaration name: (qualified_name) @name) @definition.namespace
(file_scoped_namespace_declaration name: (identifier) @name) @definition.namespace
(file_scoped_namespace_declaration name: (qualified_name) @name) @definition.namespace

; Methods & Properties
(method_declaration name: (identifier) @name) @definition.method
(local_function_statement name: (identifier) @name) @definition.function
(constructor_declaration name: (identifier) @name) @definition.constructor
(property_declaration name: (identifier) @name) @definition.property

; Primary constructors (C# 12): class User(string name, int age) { }
(class_declaration name: (identifier) @name (parameter_list) @definition.constructor)
(record_declaration name: (identifier) @name (parameter_list) @definition.constructor)

; Using
(using_directive (qualified_name) @import.source) @import
(using_directive (identifier) @import.source) @import

; Calls
(invocation_expression function: (identifier) @call.name) @call
(invocation_expression function: (member_access_expression name: (identifier) @call.name)) @call

; Null-conditional method calls: user?.Save()
; Parses as: invocation_expression → conditional_access_expression → member_binding_expression → identifier
(invocation_expression
  function: (conditional_access_expression
    (member_binding_expression
      (identifier) @call.name))) @call

; Constructor calls: new Foo() and new Foo { Props }
(object_creation_expression type: (identifier) @call.name) @call

; Target-typed new (C# 9): User u = new("x", 5)
(variable_declaration type: (identifier) @call.name (variable_declarator (implicit_object_creation_expression) @call))

; Heritage
(class_declaration name: (identifier) @heritage.class
  (base_list (identifier) @heritage.extends)) @heritage
(class_declaration name: (identifier) @heritage.class
  (base_list (generic_name (identifier) @heritage.extends))) @heritage

; Type references — captures types used in field/param/return-type positions
(parameter type: (identifier) @reference.type)
(variable_declaration type: (identifier) @reference.type)
(field_declaration (variable_declaration type: (identifier) @reference.type))
(method_declaration returns: (identifier) @reference.type)
`;

// Rust queries - works with tree-sitter-rust
export const RUST_QUERIES = `
; Functions & Items
(function_item name: (identifier) @name) @definition.function
(struct_item name: (type_identifier) @name) @definition.struct
(enum_item name: (type_identifier) @name) @definition.enum
(trait_item name: (type_identifier) @name) @definition.trait
(impl_item type: (type_identifier) @name !trait) @definition.impl
(impl_item type: (generic_type type: (type_identifier) @name) !trait) @definition.impl
(mod_item name: (identifier) @name) @definition.module

; Type aliases, const, static, macros
(type_item name: (type_identifier) @name) @definition.type
(const_item name: (identifier) @name) @definition.const
(static_item name: (identifier) @name) @definition.static
(macro_definition name: (identifier) @name) @definition.macro

; Use statements
(use_declaration argument: (_) @import.source) @import

; Calls
(call_expression function: (identifier) @call.name) @call
(call_expression function: (field_expression field: (field_identifier) @call.name)) @call
(call_expression function: (scoped_identifier
  path: (identifier) @_qualifier
  name: (identifier) @call.name)) @call
(call_expression function: (generic_function function: (identifier) @call.name)) @call

; Struct literal construction: User { name: value }
(struct_expression name: (type_identifier) @call.name) @call

; Type references — captures types used in field/param/return-type positions
(field_declaration type: (type_identifier) @reference.type)
(parameter pattern: (_) type: (type_identifier) @reference.type)
(function_item return_type: (type_identifier) @reference.type)

; Wrapped type references — &Type, &mut Type
(field_declaration type: (reference_type (type_identifier) @reference.type))
(parameter pattern: (_) type: (reference_type (type_identifier) @reference.type))
(function_item return_type: (reference_type (type_identifier) @reference.type))

; Generic wrapper types — Box<Type>, Arc<Type>, Vec<Type>, Option<Type>, Result<Type,_>, etc.
; Capture the type argument (inner type), not the wrapper name.
(field_declaration type: (generic_type type_arguments: (type_arguments (type_identifier) @reference.type)))
(parameter pattern: (_) type: (generic_type type_arguments: (type_arguments (type_identifier) @reference.type)))
(function_item return_type: (generic_type type_arguments: (type_arguments (type_identifier) @reference.type)))

; impl Trait in parameter / return positions
(parameter pattern: (_) type: (abstract_type (type_identifier) @reference.type))
(function_item return_type: (abstract_type (type_identifier) @reference.type))

; dyn Trait — trait objects (direct: fn foo(x: dyn Trait) or field: x: dyn Trait)
(field_declaration type: (dynamic_type (type_identifier) @reference.type))
(parameter pattern: (_) type: (dynamic_type (type_identifier) @reference.type))
(function_item return_type: (dynamic_type (type_identifier) @reference.type))

; dyn Trait nested inside generic wrapper — Box<dyn Trait>, Arc<dyn Trait>, etc.
(field_declaration type: (generic_type type_arguments: (type_arguments (dynamic_type (type_identifier) @reference.type))))
(parameter pattern: (_) type: (generic_type type_arguments: (type_arguments (dynamic_type (type_identifier) @reference.type))))
(function_item return_type: (generic_type type_arguments: (type_arguments (dynamic_type (type_identifier) @reference.type))))

; Heritage (trait implementation) — all combinations of concrete/generic trait × concrete/generic type
(impl_item trait: (type_identifier) @heritage.trait type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (type_identifier) @heritage.class) @heritage
(impl_item trait: (type_identifier) @heritage.trait type: (generic_type type: (type_identifier) @heritage.class)) @heritage
(impl_item trait: (generic_type type: (type_identifier) @heritage.trait) type: (generic_type type: (type_identifier) @heritage.class)) @heritage
`;

// PHP queries - works with tree-sitter-php (php_only grammar)
export const PHP_QUERIES = `
; ── Namespace ────────────────────────────────────────────────────────────────
(namespace_definition
  name: (namespace_name) @name) @definition.namespace

; ── Classes ──────────────────────────────────────────────────────────────────
(class_declaration
  name: (name) @name) @definition.class

; ── Interfaces ───────────────────────────────────────────────────────────────
(interface_declaration
  name: (name) @name) @definition.interface

; ── Traits ───────────────────────────────────────────────────────────────────
(trait_declaration
  name: (name) @name) @definition.trait

; ── Enums (PHP 8.1) ──────────────────────────────────────────────────────────
(enum_declaration
  name: (name) @name) @definition.enum

; ── Top-level functions ───────────────────────────────────────────────────────
(function_definition
  name: (name) @name) @definition.function

; ── Methods (including constructors) ─────────────────────────────────────────
(method_declaration
  name: (name) @name) @definition.method

; ── Class properties (including Eloquent $fillable, $casts, etc.) ────────────
(property_declaration
  (property_element
    (variable_name
      (name) @name))) @definition.property

; ── Imports: use statements ──────────────────────────────────────────────────
; Simple: use App\\Models\\User;
(namespace_use_declaration
  (namespace_use_clause
    (qualified_name) @import.source)) @import

; ── Function/method calls ────────────────────────────────────────────────────
; Regular function call: foo()
(function_call_expression
  function: (name) @call.name) @call

; Method call: $obj->method()
(member_call_expression
  name: (name) @call.name) @call

; Nullsafe method call: $obj?->method()
(nullsafe_member_call_expression
  name: (name) @call.name) @call

; Static call: Foo::bar() (php_only uses scoped_call_expression)
(scoped_call_expression
  name: (name) @call.name) @call

; Constructor call: new User()
(object_creation_expression (name) @call.name) @call

; ── Heritage: extends ────────────────────────────────────────────────────────
(class_declaration
  name: (name) @heritage.class
  (base_clause
    [(name) (qualified_name)] @heritage.extends)) @heritage

; ── Heritage: implements ─────────────────────────────────────────────────────
(class_declaration
  name: (name) @heritage.class
  (class_interface_clause
    [(name) (qualified_name)] @heritage.implements)) @heritage.impl

; ── Heritage: use trait (must capture enclosing class name) ──────────────────
(class_declaration
  name: (name) @heritage.class
  body: (declaration_list
    (use_declaration
      [(name) (qualified_name)] @heritage.trait))) @heritage

; ── Type references ───────────────────────────────────────────────────────────
(named_type (name) @reference.type)
`;

// Ruby queries - works with tree-sitter-ruby
export const RUBY_QUERIES = `
; ── Modules ──────────────────────────────────────────────────────────────────
(module
  name: (constant) @name) @definition.module

; ── Classes ──────────────────────────────────────────────────────────────────
(class
  name: (constant) @name) @definition.class

; Scoped class name: class Module::ClassName
(class
  name: (scope_resolution) @name) @definition.class

; ── Instance methods ─────────────────────────────────────────────────────────
(method
  name: (identifier) @name) @definition.method

; ── Singleton (class-level) methods ──────────────────────────────────────────
(singleton_method
  name: (identifier) @name) @definition.method

; ── Require / require_relative → IMPORTS ─────────────────────────────────────
; Capture the string argument so the second pass emits an IMPORTS edge.
(call
  method: (identifier) @_req
  arguments: (argument_list
    (string (string_content) @import.source))
  (#match? @_req "^require"))  @import

; ── All other calls ───────────────────────────────────────────────────────────
(call
  method: (identifier) @call.name) @call

; ── Bare calls without parens (identifiers at statement level are method calls) ─
; NOTE: This may over-capture variable reads as calls (e.g. 'result' at
; statement level). Ruby's grammar makes bare identifiers ambiguous — they
; could be local variables or zero-arity method calls. Post-processing via
; the BUILTINS set suppresses most false positives.
(body_statement
  (identifier) @call.name @call)

; ── Heritage: class < SuperClass ─────────────────────────────────────────────
(class
  name: (constant) @heritage.class
  superclass: (superclass
    (constant) @heritage.extends)) @heritage

; Scoped superclass: class Foo < Module::Class
; Captures full "Module::Class" text to avoid ambiguity with bare "Class" names
(class
  name: (constant) @heritage.class
  superclass: (superclass
    (scope_resolution) @heritage.extends)) @heritage

; Scoped class name, bare superclass: class Module::Foo < Bar
(class
  name: (scope_resolution) @heritage.class
  superclass: (superclass
    (constant) @heritage.extends)) @heritage

; Scoped class name, scoped superclass: class Module::Foo < Module::Bar
(class
  name: (scope_resolution) @heritage.class
  superclass: (superclass
    (scope_resolution) @heritage.extends)) @heritage
`;

// Kotlin queries - works with tree-sitter-kotlin (fwcd/tree-sitter-kotlin)
// Based on official tags.scm; functions use simple_identifier, classes use type_identifier
export const KOTLIN_QUERIES = `
; ── Interfaces ─────────────────────────────────────────────────────────────
; tree-sitter-kotlin (fwcd) has no interface_declaration node type.
; Interfaces are class_declaration nodes with an anonymous "interface" keyword child.
(class_declaration
  "interface"
  (type_identifier) @name) @definition.interface

; ── Classes (regular, data, sealed, enum) ────────────────────────────────
; All have the anonymous "class" keyword child. enum class has both
; "enum" and "class" children — the "class" child still matches.
(class_declaration
  "class"
  (type_identifier) @name) @definition.class

; ── Object declarations (Kotlin singletons) ──────────────────────────────
(object_declaration
  (type_identifier) @name) @definition.class

; ── Companion objects (named only) ───────────────────────────────────────
(companion_object
  (type_identifier) @name) @definition.class

; ── Functions (top-level, member, extension) ──────────────────────────────
(function_declaration
  (simple_identifier) @name) @definition.function

; ── Properties ───────────────────────────────────────────────────────────
(property_declaration
  (variable_declaration
    (simple_identifier) @name)) @definition.property

; ── Enum entries ─────────────────────────────────────────────────────────
(enum_entry
  (simple_identifier) @name) @definition.enum

; ── Type aliases ─────────────────────────────────────────────────────────
(type_alias
  (type_identifier) @name) @definition.type

; ── Imports ──────────────────────────────────────────────────────────────
(import_header
  (identifier) @import.source) @import

; ── Function calls (direct) ──────────────────────────────────────────────
(call_expression
  (simple_identifier) @call.name) @call

; ── Method calls (via navigation: obj.method()) ──────────────────────────
(call_expression
  (navigation_expression
    (navigation_suffix
      (simple_identifier) @call.name))) @call

; ── Constructor invocations ──────────────────────────────────────────────
(constructor_invocation
  (user_type
    (type_identifier) @call.name)) @call

; ── Infix function calls (e.g., a to b, x until y) ──────────────────────
(infix_expression
  (simple_identifier) @call.name) @call

; ── Heritage: extends / implements via delegation_specifier ──────────────
; Interface implementation (bare user_type): class Foo : Bar
(class_declaration
  (type_identifier) @heritage.class
  (delegation_specifier
    (user_type (type_identifier) @heritage.extends))) @heritage

; Class extension (constructor_invocation): class Foo : Bar()
(class_declaration
  (type_identifier) @heritage.class
  (delegation_specifier
    (constructor_invocation
      (user_type (type_identifier) @heritage.extends)))) @heritage

; ── Type references ───────────────────────────────────────────────────────────
(type_reference (user_type (type_identifier) @reference.type))
`;

// Swift queries - works with tree-sitter-swift
export const SWIFT_QUERIES = `
; Classes
(class_declaration "class" name: (type_identifier) @name) @definition.class

; Structs
(class_declaration "struct" name: (type_identifier) @name) @definition.struct

; Enums
(class_declaration "enum" name: (type_identifier) @name) @definition.enum

; Extensions (mapped to class — no dedicated label in schema)
(class_declaration "extension" name: (user_type (type_identifier) @name)) @definition.class

; Actors
(class_declaration "actor" name: (type_identifier) @name) @definition.class

; Protocols (mapped to interface)
(protocol_declaration name: (type_identifier) @name) @definition.interface

; Type aliases
(typealias_declaration name: (type_identifier) @name) @definition.type

; Functions (top-level and methods)
(function_declaration name: (simple_identifier) @name) @definition.function

; Protocol method declarations
(protocol_function_declaration name: (simple_identifier) @name) @definition.method

; Initializers — "init" is the canonical name; line offset tracked via definition node
(init_declaration "init" @name) @definition.constructor

; Properties (stored and computed)
(property_declaration (pattern (simple_identifier) @name)) @definition.property

; Imports
(import_declaration (identifier (simple_identifier) @import.source)) @import

; Calls - direct function calls
(call_expression (simple_identifier) @call.name) @call

; Calls - member/navigation calls (obj.method())
(call_expression (navigation_expression (navigation_suffix (simple_identifier) @call.name))) @call

; Heritage - class/struct/enum inheritance and protocol conformance
(class_declaration name: (type_identifier) @heritage.class
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Heritage - protocol inheritance
(protocol_declaration name: (type_identifier) @heritage.class
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Heritage - extension protocol conformance (e.g. extension Foo: SomeProtocol)
; Extensions wrap the name in user_type unlike class/struct/enum declarations
(class_declaration "extension" name: (user_type (type_identifier) @heritage.class)
  (inheritance_specifier inherits_from: (user_type (type_identifier) @heritage.extends))) @heritage

; Type references — captures types used in annotations/parameters/return types
(type_annotation (user_type (type_identifier) @reference.type))
`;

// Scala queries - works with tree-sitter-scala
export const SCALA_QUERIES = `
; ── Classes (class, case class, abstract class, sealed class) ────────────────
(class_definition
  name: (identifier) @name) @definition.class

; ── Traits (mapped to interface) ─────────────────────────────────────────────
(trait_definition
  name: (identifier) @name) @definition.interface

; ── Object definitions (companion objects, case objects, singletons) ─────────
(object_definition
  name: (identifier) @name) @definition.class

; ── Function / method definitions ────────────────────────────────────────────
(function_definition
  name: (identifier) @name) @definition.function

; ── Abstract method declarations (in traits / abstract classes) ──────────────
(function_declaration
  name: (identifier) @name) @definition.method

; ── Type aliases ──────────────────────────────────────────────────────────────
(type_definition
  name: (type_identifier) @name) @definition.type

; ── Val/var definitions (class-level members only, not method-local vars) ──────
; Restricting to template_body ensures we only capture class/object-level
; declarations (e.g. companion object implicits) and not local val bindings
; inside method bodies, which would add noise entities to the graph.
(template_body
  (val_definition (identifier) @name) @definition.const)

(template_body
  (var_definition (identifier) @name) @definition.const)

; ── Imports: capture full declaration for dotted-path reconstruction ─────────
; Handles: import ix.memory.model._  (wildcard)
;          import ix.memory.model.{NodeKind, GraphNode}  (selective)
;          import ix.memory.model.NodeKind  (simple)
(import_declaration) @import.stmt

; ── Calls: direct function call ──────────────────────────────────────────────
(call_expression
  function: (identifier) @call.name) @call

; ── Calls: method call (obj.method()) ────────────────────────────────────────
(call_expression
  function: (field_expression
    field: (identifier) @call.name)) @call

; ── Constructor: new Foo() ────────────────────────────────────────────────────
(instance_expression
  (type_identifier) @call.name) @call

; ── Heritage: class / object extends and with ────────────────────────────────
(class_definition
  name: (identifier) @heritage.class
  extend: (extends_clause
    (type_identifier) @heritage.extends)) @heritage

(trait_definition
  name: (identifier) @heritage.class
  extend: (extends_clause
    (type_identifier) @heritage.extends)) @heritage

(object_definition
  name: (identifier) @heritage.class
  extend: (extends_clause
    (type_identifier) @heritage.extends)) @heritage

; ── Type references ───────────────────────────────────────────────────────────
; Case class parameter types: case class Foo(x: NodeKind)
(class_parameter (type_identifier) @reference.type)
; Method parameter types: def foo(x: NodeKind)
(parameter (type_identifier) @reference.type)
; Val/var type annotations: val x: NodeKind = ...
(val_definition (type_identifier) @reference.type)
(var_definition (type_identifier) @reference.type)
; Return type annotations: def foo(): NodeKind = ...
; (type_identifier is a direct child of function_definition, no named field)
(function_definition (type_identifier) @reference.type)
; Generic type arguments: Map[NodeId, NodeKind], Option[NodeKind], Set[NodeKind], etc.
(generic_type (type_arguments (type_identifier) @reference.type))

; ── Qualified singleton / companion-object member access ──────────────────────
; Two grammar shapes arise in practice:
;   expression context:  NodeKind.Class      → field_expression
;   pattern  context:  case Some(NodeKind.Class) => … → stable_identifier
; Both shapes are captured below. The (#match? ^[A-Z]) predicates restrict to
; UpperCamelCase identifiers (Scala convention for case objects / companion
; object members), filtering out lowercase method / field names.

; Expression: val x = NodeKind.Decision
(field_expression
  value: (identifier) @_qualifier
  field: (identifier) @call.name
  (#match? @_qualifier "^[A-Z]")
  (#match? @call.name "^[A-Z]"))

; Pattern:  case Some(NodeKind.Class) | Some(NodeKind.Trait) => …
(stable_identifier
  (identifier) @_qualifier
  "."
  (identifier) @call.name
  (#match? @_qualifier "^[A-Z]")
  (#match? @call.name "^[A-Z]"))
`;

// R queries - works with @davisvaughan/tree-sitter-r
export const R_QUERIES = `
; Function definitions: foo <- function(x, y) { ... }
; Matches <-, <<-, = assignment forms (operator field is anonymous)
(binary_operator
  lhs: (identifier) @name
  rhs: (function_definition)) @definition.function

; library(pkg) and require(pkg) → IMPORTS
; Arg is a bare identifier (unquoted package name) wrapped in argument.value
(call
  function: (identifier) @_fn
  arguments: (arguments
    (argument value: (identifier) @import.source))
  (#match? @_fn "^(library|require)$")) @import

; source("file.R") → IMPORTS (quoted file path string)
(call
  function: (identifier) @_fn
  arguments: (arguments
    (argument value: (string) @import.source))
  (#match? @_fn "^source$")) @import

; Direct function calls: foo(...)
(call
  function: (identifier) @call.name) @call

; Method calls via $ operator: obj$method(...)
(call
  function: (extract_operator
    rhs: (identifier) @call.name)) @call
`;

export const LANGUAGE_QUERIES: Record<SupportedLanguages, string> = {
  [SupportedLanguages.TypeScript]: TYPESCRIPT_QUERIES,
  [SupportedLanguages.JavaScript]: JAVASCRIPT_QUERIES,
  [SupportedLanguages.Python]: PYTHON_QUERIES,
  [SupportedLanguages.Java]: JAVA_QUERIES,
  [SupportedLanguages.C]: C_QUERIES,
  [SupportedLanguages.Go]: GO_QUERIES,
  [SupportedLanguages.CPlusPlus]: CPP_QUERIES,
  [SupportedLanguages.CSharp]: CSHARP_QUERIES,
  [SupportedLanguages.Ruby]: RUBY_QUERIES,
  [SupportedLanguages.Rust]: RUST_QUERIES,
  [SupportedLanguages.PHP]: PHP_QUERIES,
  [SupportedLanguages.Kotlin]: KOTLIN_QUERIES,
  [SupportedLanguages.Swift]: SWIFT_QUERIES,
  [SupportedLanguages.Scala]: SCALA_QUERIES,
  [SupportedLanguages.YAML]: '',
  [SupportedLanguages.Dockerfile]: '',
  [SupportedLanguages.SQL]: '',
  [SupportedLanguages.JSON]: '',
  [SupportedLanguages.TOML]: '',
  [SupportedLanguages.Markdown]: '',
  [SupportedLanguages.R]: R_QUERIES,
};
 
