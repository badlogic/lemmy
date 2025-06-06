# Java-to-C++ Type Porting

## Overview

We are working collaboratively on the Spine Runtime, a skeletal animation library for loading, manipulating and rendering Spine skeletons, porting Java code changes to C++. The Spine project maintains parallel implementations in multiple languages, and we need to keep the C++ version synchronized with Java updates.

Our work is tracked in `porting-plan.json` which contains git branches, deleted files, the spine runtimes directory, and a priority-ordered porting sequence. The types in the porting-plan.json file (PortingPlan, PortingOrderItem, DeletedJavaFile) are described in src/types.ts (relative to this file).

**Working Directory:** Paths are relative to the spine-runtimes directory:

- **Java sources:** `spine-libgdx/spine-libgdx/src/com/esotericsoftware/spine/`
- **C++ sources:** `spine-cpp/spine-cpp/src/spine/` and `spine-cpp/spine-cpp/include/spine/`

You are provided with tools to collaborate on the porting with the user, as well as a step by step workflow you execute together with the user.

## Tools

### File Viewer

The user might want to view changes for review, question asking, or advice giving. For this, use the file viewer - a web-based interface with two panels: a tabbed left panel for multiple files and a single-file right panel. Both panels support syntax highlighting, diff views, and real-time updates.

**Start the dev server first (from the folder where port.md is located):**

```bash
# Always kill old dev servers before starting new ones
pkill -f "npx tsx src/dev-server.ts" || true
nohup npx tsx src/dev-server.ts > dev-server.log 2>&1 &
sleep 2
cat dev-server.log
```

**Then use puppeteer to navigate and control the viewer:**

```javascript
// Navigate to the viewer (find the port number in dev-server.log output)
// For full-screen usage, use maximized window without viewport constraints:
mcp__puppeteer__puppeteer_navigate("http://localhost:PORT", {
	launchOptions: { headless: false, args: ["--start-maximized"], defaultViewport: null },
});

// Open files in panel 0 (left, tabbed) - all paths must be absolute
mcp__puppeteer__puppeteer_evaluate(`
  fileViewer.open("/path/to/spine-runtimes/spine-libgdx/spine-libgdx/src/com/esotericsoftware/spine/Animation.java", 0, "4.2", "4.3-beta");
  fileViewer.open("/path/to/spine-runtimes/spine-libgdx/spine-libgdx/src/com/esotericsoftware/spine/Bone.java", 0, "4.2", "4.3-beta");
`);

// Open file in panel 1 (right, single file)
mcp__puppeteer__puppeteer_evaluate(
	'fileViewer.open("/path/to/spine-runtimes/spine-cpp/spine-cpp/include/spine/Animation.h", 1, "4.2")',
);

// View documentation or any file
mcp__puppeteer__puppeteer_evaluate('fileViewer.open("/Users/badlogic/workspaces/lemmy/apps/port-cpp/port.md", 1)');

// Close specific files
mcp__puppeteer__puppeteer_evaluate('fileViewer.close("/path/to/Animation.java")');

// Close all files
mcp__puppeteer__puppeteer_evaluate("fileViewer.closeAll()");

// Highlight specific line in an open file (useful for showing Java types being ported)
mcp__puppeteer__puppeteer_evaluate(`
  fileViewer.highlightLine("/path/to/spine-runtimes/spine-libgdx/spine-libgdx/src/com/esotericsoftware/spine/Animation.java", 565);
`);
```

**fileViewer API:**

- **`fileViewer.open(absolutePath, panel, prevBranch?, currBranch?)`** - Open file in panel 0 (tabbed) or 1 (single)
- **`fileViewer.close(absolutePath)`** - Close specific file (auto-hides panel 1 if that file closed)
- **`fileViewer.closeAll()`** - Close all files in both panels
- **`fileViewer.highlightLine(absolutePath, lineNumber)`** - Highlight and scroll to specific line in an open file (works in both content and diff modes)

**Git Diff Logic:**

- **Both branches provided** → diff between `prevBranch..currBranch`
- **Only prevBranch provided** → current state vs. that branch
- **No branches** → current state vs. HEAD (if git repo), no diff otherwise

**Panel Behavior:**

- **Panel 0 (Left)**: Tabbed interface, multiple files, shows "No files opened" when empty
- **Panel 1 (Right)**: Single file view, auto-hides when no file open
- **All paths must be absolute** - no relative path resolution

This allows the user to visually observe the changes you make during porting and provides a collaborative review interface. Can also be used if the user requests to view a specific file.

### Build Tool

**ONLY when explicitly requested by the user,** verify compilation using the CMake build system:

```bash
./build.sh  # Located in the same folder as this port.md file
```

**Important Notes:**

- **Build failures are often expected** due to circular dependencies between types
- A failed build after porting one type does NOT mean the porting was incorrect
- Multiple related types may need to be ported before the code compiles cleanly

## Step-by-Step Workflow

### 0. Load Porting Plan metadata

If `porting-plan.json` doesn't exist in the current working directory, ask the user for the file's location. Fetch the porting plan metadata and extract the spine runtimes directory from `metadata.spineRuntimesDir` for constructing absolute paths to source files, as well as the previous and current branch names diffs for the Java files have been generated from.

```bash
# Fetch porting plan metadata
jq '.metadata' porting-plan.json
```

**IMPORTANT:** Never read `porting-plan.json` entirely using the Read tool, as it's too large. Always use `jq` commands to read specific parts and update it.

### 1. Start Dev Server and Spin Up Puppeteer

First kill all running dev servers, then start the development server and open the file viewer using puppeteer for collaborative viewing.

```bash
# Kill any existing dev servers
pkill -f "dev-server.ts" || true
```

### 2. Find the Next Type to Port

Use jq to extract the next item to port from "porting-plan.json":

```bash
# Find the next pending type in priority order
jq -r '.portingOrder[] | select(.portingState == "pending") | . | @json' porting-plan.json | head -1 | jq .
```

This finds the first `PortingOrderItem` where `portingState` is "pending". The `portingOrder` array is sorted by priority:

1. **Zero dependencies first** - interfaces and enums with no dependencies
2. **New files (added)** - get slight priority boost for fresh implementation
3. **Interfaces and enums** - foundational types get priority boost
4. **Classes by dependency count** - fewer dependencies first

Open the Java file of the type and the candidate target files in the viewer using puppeteer. **IMPORTANT:** The Java source for the currently ported Java type MUST be opened in the right panel (index 1), while target files must be opened in the left panel (index 0).

### 3. Confirm with User

**STOP HERE** and ask the user if this is the type they want to work on. Show them the complete `PortingOrderItem` JSON.

### 4. Read and show the Java Source Code

Use the Read tool to examine the Java type at the specified file path and line range. **IMPORTANT:** Always use the exact `startLine` and `endLine` from the `PortingOrderItem` to read the complete type definition - use `offset=startLine` and `limit=(endLine-startLine+1)` to capture the entire type.

If the file is too large and the Read tool returns an error or truncated content, read it in chunks using multiple Read calls with different offset and limit parameters.

Open the Java source file in the righ panel in the file viewer (index 1), and highlight the Java type's `startLine`. Do this in one `mcp__puppeteer__puppeteer_evaluate()` call.

### 5. Check if Git Changes Affect This Type

Use git diff between `prevBranch` and `currentBranch` (from porting plan metadata) to see if changes actually touch this type's lines. If the git diff shows no changes for this type, you MUST ask the user what to do next.

### 6. Port to C++

In this step you are encouraged to collaborate with the user, ask them questions in case something is unclear.

- Read the complete existing C++ files (both header and source if they exist) to understand the current implementation. Use the Read tool and read in chunks if files are large.
- **CRITICAL: Always do a complete mechanical translation** - never just add documentation comments and call it "done". The Java source must be ported faithfully and exhaustively.
- **Compare EVERY aspect** of the Java class with the C++ version:
   - Class structure and inheritance (must match Java exactly)
   - All member variables (with proper C++ naming: `_underscore` prefix for private)
   - All constants (static final → static const)
   - All method signatures
   - All method implementations (translate Java logic to C++ following spine-cpp patterns and container classes like Vector instead of Java's Array.)
   - Documentation comments
- If there are missing dependencies, infer their methods and fields from the corresponding Java type(s) and perform a mechanical translation, translating from Java to likely C++ signatures using the spine-cpp conventions detailed below.
- **If C++ files don't exist:** Create them from scratch using spine-cpp conventions, then open them in the file viewers left panel (index 0)
- **If C++ files exist:**
   - Open the files in the file viewer's left panel (index 0)
   - Retain unaffected code in it
   - Compare line-by-line with Java implementation
   - Add any missing members, methods, or logic
   - Update any incorrect implementations
   - Ensure C++ version has 100% functional parity with Java
- **Never mark as "done" unless the C++ implementation is functionally complete and matches the Java type**
- **For new types or types whose name and thus .h files have changed:** Add the header include to `spine.h`

IMPORTANT: DO NOT FORGET TO OPEN NEWLY CREATED FILES IN THE LEFT PANEL (index 0)

### 7. Update the Porting Plan

Update the `PortingOrderItem` in the porting plan with your results:

```bash
# Update porting status for a completed type
TYPE_NAME="Animation"  # Replace with the type you just ported
jq --arg name "$TYPE_NAME" --arg state "done" --arg notes "Successfully ported Animation class..." \
   '(.portingOrder[] | select(.simpleName == $name) | .portingState) |= $state |
    (.portingOrder[] | select(.simpleName == $name) | .portingNotes) |= $notes' \
   porting-plan.json > tmp.json && mv tmp.json porting-plan.json
```

Output the resulting JSON to the user.

### 8. STOP and Ask for Confirmation

- **MANDATORY:** After completing any type, you MUST STOP immediately
- Tell the user exactly what you accomplished
- Tell the user what you would work on next and why
- **WAIT for user confirmation** before proceeding to the next type
- This ensures proper pacing and prevents rushing through incomplete work

## Spine-C++ Conventions

### Mapping File Names

Each Java type typically maps to two C++ files: a header (.h) and source (.cpp) file.

- **Java:** `spine-libgdx/spine-libgdx/src/com/esotericsoftware/spine/TypeName.java`
- **C++ Header:** `spine-cpp/spine-cpp/include/spine/TypeName.h`
- **C++ Source:** `spine-cpp/spine-cpp/src/spine/TypeName.cpp`

Note: A single Java file may contain multiple types, so you cannot rely on file names alone for mapping.

### Type Translations

- **Java class** → C++ class inheriting SpineObject + RTTI (include `spine/RTTI.h`)
- **Java interface** → C++ abstract class with pure virtual methods + RTTI (include `spine/RTTI.h`)
- **Java enum** → C++ enum in namespace spine (header-only, no .cpp)

### Code Patterns

**Class Structure:**

- All classes inherit from `SpineObject` (provides custom memory management)
- Use `RTTI_DECL` in header and `RTTI_IMPL(ClassName, ParentClass)` in source
- Private fields have `_underscore` prefix
- Public methods use exact Java names (camelCase)

**Container Types:**

- Java `Array` → `spine::Vector<T>` (not `std::vector`)
- Java `String` → `spine::String` (not `std::string`)
- Use spine's custom containers for consistency and memory management

**Memory Management:**

- Allocate using `SpineExtension::calloc<T>()` or `new (__FILE__, __LINE__)`
- All allocations track file/line for debugging
- Objects inherit SpineObject's custom new/delete operators

**Code Organization:**

- Prefer forward declarations of classes in header files
- All code is in the `spine` namespace
- Source files use `using namespace spine;`
- Follow existing patterns in the file you're editing

**Header Example:**

```cpp
#include <spine/SpineObject.h>
#include <spine/RTTI.h>
#include <spine/Vector.h>

class SP_API ClassName : public ParentClass {
    RTTI_DECL
private:
    spine::Vector<SomeType*> _items;
    spine::String _name;
    float _value;
public:
    ClassName(float value);
    void someMethod();
};
```

**Source Example:**

```cpp
#include <spine/ClassName.h>
using namespace spine;

RTTI_IMPL(ClassName, ParentClass)

ClassName::ClassName(float value) : ParentClass(), _value(value) {
    // Constructor body
}
```

**Enum Example:**

```cpp
namespace spine {
    enum MixBlend {
        MixBlend_Setup,
        MixBlend_First,
        MixBlend_Replace,
        MixBlend_Add
    };
}
```

**Interface → Abstract Class Example:**

```cpp
// Header: AttachmentLoader.h
#include <spine/SpineObject.h>
#include <spine/RTTI.h>

namespace spine {
    class Attachment;
    class Skin;

    class SP_API AttachmentLoader : public SpineObject {
        RTTI_DECL
    public:
        AttachmentLoader();
        virtual ~AttachmentLoader();
        virtual Attachment* newRegionAttachment(Skin& skin, const String& name, const String& path) = 0;
        virtual Attachment* newMeshAttachment(Skin& skin, const String& name, const String& path) = 0;
    };
}
```

```cpp
// Source: AttachmentLoader.cpp
#include <spine/AttachmentLoader.h>

using namespace spine;

RTTI_IMPL(AttachmentLoader, SpineObject)

AttachmentLoader::AttachmentLoader() {
}

AttachmentLoader::~AttachmentLoader() {
}
```
