import assert from 'node:assert';
import { extract, languageForPath } from './importResolvers';

export function runImportResolverTests(): void {
  console.log('Running importResolvers tests...');

  // 1. Language detection
  assert.strictEqual(languageForPath('src/file.ts'), 'typescript');
  assert.strictEqual(languageForPath('src/file.js'), 'javascript');
  assert.strictEqual(languageForPath('index.php'), 'php');
  assert.strictEqual(languageForPath('main.py'), 'python');
  assert.strictEqual(languageForPath('main.go'), 'go');
  assert.strictEqual(languageForPath('lib/main.dart'), 'dart');
  assert.strictEqual(languageForPath('src/lib.rs'), 'rust');
  assert.strictEqual(languageForPath('main.cpp'), 'cpp');
  assert.strictEqual(languageForPath('Header.h'), 'cpp');
  assert.strictEqual(languageForPath('App.java'), 'java');
  assert.strictEqual(languageForPath('Main.kt'), 'kotlin');
  assert.strictEqual(languageForPath('app.rb'), 'ruby');
  assert.strictEqual(languageForPath('View.swift'), 'swift');
  assert.strictEqual(languageForPath('README.md'), 'unknown');

  // 2. JS / TS
  const jsCode = `
    import { foo } from './utils';
    import type { Config } from '../config';
    const bar = require('express');

    export function calculate(x: number): number { return x * 2; }
    export class Service {}
    interface InternalConfig {}
  `;
  const jsResult = extract('src/app.ts', jsCode);
  assert.deepStrictEqual(jsResult.imports.sort(), ['./utils', '../config', 'express'].sort());
  assert.ok(jsResult.symbols.some((s) => s.name === 'calculate' && s.kind === 'function'));
  assert.ok(jsResult.symbols.some((s) => s.name === 'Service' && s.kind === 'class'));
  assert.ok(jsResult.exports.includes('calculate'));
  assert.ok(jsResult.exports.includes('Service'));

  // 3. PHP
  const phpCode = `<?php
    use App\\Models\\User;
    require_once 'config/database.php';

    class UserController {
      public function index() {}
    }
  `;
  const phpResult = extract('controllers/UserController.php', phpCode);
  assert.ok(phpResult.imports.includes('App\\Models\\User'));
  assert.ok(phpResult.imports.includes('config/database.php'));
  assert.ok(phpResult.symbols.some((s) => s.name === 'UserController' && s.kind === 'class'));

  // 4. Python
  const pyCode = `
import os
from datetime import datetime

class DataProcessor:
    def process(self):
        pass

def helper():
    pass
  `;
  const pyResult = extract('processor.py', pyCode);
  assert.ok(pyResult.imports.includes('os'));
  assert.ok(pyResult.imports.includes('datetime'));
  assert.ok(pyResult.symbols.some((s) => s.name === 'DataProcessor' && s.kind === 'class'));
  assert.ok(pyResult.symbols.some((s) => s.name === 'helper' && s.kind === 'def'));

  // 5. Go
  const goCode = `
package main

import (
    "fmt"
    "net/http"
)

type Server struct{}

func StartServer() {}
  `;
  const goResult = extract('main.go', goCode);
  assert.ok(goResult.imports.includes('fmt'));
  assert.ok(goResult.imports.includes('net/http'));
  assert.ok(goResult.symbols.some((s) => s.name === 'Server' && s.kind === 'type'));
  assert.ok(goResult.symbols.some((s) => s.name === 'StartServer' && s.kind === 'func'));
  assert.ok(goResult.exports.includes('StartServer'));
  assert.ok(!goResult.exports.includes('server'));

  // 6. Dart
  const dartCode = `
import 'package:flutter/material.dart';
import 'src/widgets.dart';

class MyWidget extends StatelessWidget {}
void _privateHelper() {}
  `;
  const dartResult = extract('lib/main.dart', dartCode);
  assert.ok(dartResult.imports.includes('package:flutter/material.dart'));
  assert.ok(dartResult.imports.includes('src/widgets.dart'));
  assert.ok(dartResult.symbols.some((s) => s.name === 'MyWidget' && s.kind === 'class'));
  assert.ok(dartResult.exports.includes('MyWidget'));
  assert.ok(!dartResult.exports.includes('_privateHelper'));

  // 7. Rust
  const rustCode = `
use std::collections::HashMap;
mod utils;

pub struct Config {}
fn private_fn() {}
  `;
  const rustResult = extract('src/lib.rs', rustCode);
  assert.ok(rustResult.imports.includes('std::collections::HashMap'));
  assert.ok(rustResult.imports.includes('utils'));
  assert.ok(rustResult.symbols.some((s) => s.name === 'Config' && s.kind === 'struct'));
  assert.ok(rustResult.exports.includes('Config'));
  assert.ok(!rustResult.exports.includes('private_fn'));

  // 8. C / C++
  const cppCode = `
#include <iostream>
#include "header.h"

namespace Engine {
    class Renderer {
        void render();
    };
}
  `;
  const cppResult = extract('engine.cpp', cppCode);
  assert.ok(cppResult.imports.includes('iostream'));
  assert.ok(cppResult.imports.includes('header.h'));
  assert.ok(cppResult.symbols.some((s) => s.name === 'Renderer' && s.kind === 'class'));
  assert.ok(cppResult.symbols.some((s) => s.name === 'Engine' && s.kind === 'namespace'));

  // 9. Java
  const javaCode = `
package com.example;

import java.util.List;

public class Application {
    public void run() {}
}
  `;
  const javaResult = extract('Application.java', javaCode);
  assert.ok(javaResult.imports.includes('java.util.List'));
  assert.ok(javaResult.symbols.some((s) => s.name === 'Application' && s.kind === 'class'));
  assert.ok(javaResult.exports.includes('Application'));

  // 10. Kotlin
  const ktCode = `
package com.example

import kotlinx.coroutines.flow.Flow

data class User(val id: String)
fun main() {}
  `;
  const ktResult = extract('Main.kt', ktCode);
  assert.ok(ktResult.imports.includes('kotlinx.coroutines.flow.Flow'));
  assert.ok(ktResult.symbols.some((s) => s.name === 'User'));
  assert.ok(ktResult.symbols.some((s) => s.name === 'main'));

  // 11. Ruby
  const rbCode = `
require 'json'
require_relative 'config'

class ApiClient
  def fetch_data
  end
end
  `;
  const rbResult = extract('api.rb', rbCode);
  assert.ok(rbResult.imports.includes('json'));
  assert.ok(rbResult.imports.includes('config'));
  assert.ok(rbResult.symbols.some((s) => s.name === 'ApiClient' && s.kind === 'class'));

  // 12. Swift
  const swiftCode = `
import UIKit
import Foundation

public struct UserViewModel {}
func localFunc() {}
  `;
  const swiftResult = extract('UserViewModel.swift', swiftCode);
  assert.ok(swiftResult.imports.includes('UIKit'));
  assert.ok(swiftResult.imports.includes('Foundation'));
  assert.ok(swiftResult.symbols.some((s) => s.name === 'UserViewModel' && s.kind === 'struct'));

  console.log('All importResolvers tests passed successfully!');
}

if (require.main === module) {
  runImportResolverTests();
}
