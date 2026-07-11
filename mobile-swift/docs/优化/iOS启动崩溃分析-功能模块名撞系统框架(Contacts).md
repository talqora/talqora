# iOS 启动崩溃分析:功能模块名 `Contacts` 撞 Apple 系统框架

> 日期:2026-07-06 · 分支:`ios` · 关联提交:`fc05e70`(全项目模块化)
> 场景:把通讯录功能抽成独立 Tuist framework、目标名取作 **`Contacts`** 后,`xcodebuild test` 的**测试宿主(OurChat.app)启动即崩**,编译与链接全程零警告。改名 `ContactBook` 后消失。

---

## 0. 一句话结论

我们生成了一个叫 `Contacts.framework` 的**动态框架**,与 Apple 系统的 `Contacts.framework` **同名**。运行时把 Apple 的 Contacts UI 栈(`ContactsUICore`)拽进了进程;测试宿主启动时会**强制实现(realize)进程内所有类**,当实现到 `ContactsUICore` 里一个用了 `Combine.@Published` 的类时,Swift 泛型元数据解析在同名框架间**串线**,拿到一个 **NULL 元数据指针**,读地址 `0x0` → `EXC_BAD_ACCESS(SIGSEGV)`。

根因是**动态框架标识(install name)撞车**,不是我们的业务代码有 bug。修法:模块**改名**,避开系统框架名。

---

## 1. 现象与触发条件

| 维度 | 观察 |
|---|---|
| 触发动作 | `xcodebuild test`(或 Xcode 跑测试)拉起测试宿主 `OurChat.app` |
| 崩溃时机 | **进程启动、测试用例还没跑**(bootstrapping 阶段) |
| 报错面 | `xcodebuild` 只给一句 `Early unexpected exit, operation never finished bootstrapping … OurChat at <external symbol>`——**不指向任何业务代码** |
| 编译/链接 | **完全通过,零警告** |
| App 直接运行 | 未必崩(见 §5):崩点依赖"实现到 ContactsUICore 的类",纯 App 若不触及可能侥幸不崩;**测试宿主必崩**(强制枚举实现所有类) |
| 复现确定性 | 稳定复现(改名前每次跑 test 必崩) |
| 消失条件 | 模块名 `Contacts` → `ContactBook` 后彻底消失,183 tests 全绿 |

---

## 2. 关键证据(crash report 摘录)

**异常类型**
```
Exception Type:  EXC_BAD_ACCESS (SIGSEGV)
Exception Subtype: KERN_INVALID_ADDRESS at 0x0000000000000000
far: 0x0000000000000000   x0: 0x0000000000000000
esr: 0x92000006 (Data Abort) byte read Translation fault
```
读**空地址**导致的段错误。`x0 == 0`(方法的 `this`/self 是 NULL),`far == 0`(faulting address = 0)。

**两个同名 `Contacts`(Binary Images)**
```
com.ourchat.ios.feature.contacts (1.0)  …/Debug-iphonesimulator/Contacts.framework/Contacts   ← 我们的
com.apple.Contacts.ContactsUICore (…)   …/ContactsUICore.framework/ContactsUICore              ← Apple 私有 Contacts UI 核心
com.apple.combine (1.0)                  …/Combine.framework/Combine                            ← 崩在它的泛型里
```
> 我们的 `Contacts.framework` 的 bundleId 仍是 `com.ourchat.ios.feature.contacts`——证明这份 crash 来自**改名前**的构建。

---

## 3. 调用栈逐帧解读(faulting thread,自下而上)

```
57 dyld  start
56 ???
55 OurChatApp.$main / __debug_main_executable_dylib_entry_point     ← App 入口
54 static App.main()  (SwiftUI)
…  UIApplicationMain → -[UIApplication _run] → CFRunLoop            ← 正常启动跑起 runloop
42 libXCTestBundleInject  RunTestsFromRunLoop                       ← 测试注入器开始建测试树
40 -[XCTestDriver _runTests]
27 +[XCTestSuite testSuiteForTestConfiguration:]
25 +[XCTestSuite suitesForBundlesIncludingEmptySuites:]
24 +[XCTestCase(RuntimeUtilities) allSubclasses]
23 +[XCTestCase(RuntimeUtilities) _allSubclasses]                   ← 关键:枚举"所有" XCTestCase 子类
22 objc_copyClassList                                               ← 取进程内全部类
21 realizeAllClasses()                                             ← 强制"实现"每一个类
20 realizeClassMaybeSwiftMaybeRelock(...)
19 ContactsUICore  (+0x1a55e0)                                     ← 实现到 ContactsUICore 的某个类
18 swift_getSingletonMetadata                                     ← 该类要单例元数据
17 …SingletonMetadataCacheEntry…doInitialization
16 ContactsUICore  (+0x1a57b4)
15 ContactsUICore  (+0x1a59d8)
14 __swift_instantiateGenericMetadata  (Combine)                  ← 需要一个泛型类型的元数据
13 _swift_getGenericMetadata
…
 9 type metadata completion function for Published   (Combine)    ← 该泛型是 Combine.Published<…>
 8 __swift_instantiateGenericMetadata  (Combine)
…
 3 type metadata completion function for Published.Storage (Combine) ← 再实例化 Published.Storage<…>
 2 swift_checkMetadataState
 1 performOnMetadataCache<…>
 0 TargetMetadata::isCanonicalStaticallySpecializedGenericMetadata() const  ← 在 NULL 元数据上取字段 → 崩
```

**读法**:测试框架在启动阶段做一件很"重"的事——`objc_copyClassList` + `realizeAllClasses()`,把进程里**每一个类都实现一遍**(为了找出所有 `XCTestCase` 子类)。轮到 `ContactsUICore` 里某个 Swift 类时,它的元数据需要 `Combine.Published<T>` / `Published.Storage<T>` 的泛型元数据;泛型元数据实例化过程中拿到的类型描述符(type descriptor)是 **NULL**,最后 `isCanonicalStaticallySpecializedGenericMetadata()` 在 `this == NULL` 上取字段,读地址 0 → 段错误。

---

## 4. 根因原理:同名动态框架 → 元数据解析串线 → NULL 指针

### 4.1 dyld 怎么标识一个框架:install name / `@rpath`

- 动态框架被别的镜像引用时,记录的是它的 **install name**,我们的是 `@rpath/Contacts.framework/Contacts`。
- App 把自研框架塞进 `OurChat.app/Frameworks/`,再用 `@rpath` 指过去。
- **同名冲突点**:Apple 也有 `Contacts.framework`(公有,module `Contacts`)+ `ContactsUI.framework` + 私有 `ContactsUICore.framework`,都在 dyld 共享缓存里。当进程里既有"我们的 Contacts"又有"苹果的 Contacts 栈"时,**"Contacts"这个名字在同一个进程里指向了两套完全不同的二进制/类型系统**。

### 4.2 为什么 Apple 的 `ContactsUICore` 会被加载进来

UIKit/系统组件在模拟器宿主里会带出一批系统私有框架,`ContactsUICore` 是其中之一(它随 UIKit 的联系人相关能力被引入)。正常情况下它自成一体;**问题是**当 `objc_copyClassList` 把它的类也拿来 `realize` 时,它类里引用的 Swift 类型要走 Swift 运行时按**名字 + 模块**解析元数据——而"Contacts"这个模块名此刻是**二义的**。

### 4.3 为什么崩在 `Combine.Published` 的泛型元数据

`ContactsUICore` 是 Apple 用 Swift + Combine 写的 UI 框架,内部有 `@Published` 属性(`Published<T>` / `Published<T>.Storage` 是泛型)。实现这种类时必须**实例化这些泛型的具体元数据**。泛型元数据实例化要用到"外层类型的类型上下文描述符"作为 key;当描述符解析因同名模块**串到错误的一侧**(我们的 Contacts 里根本没有对应类型),返回 **NULL**。

### 4.4 为什么是 NULL 指针读(`far=0` / `x0=0`)

Swift 泛型元数据缓存 `getOrInsert` 用一个 `MetadataCacheKey` 去查/建元数据。key 里的 `TargetTypeContextDescriptor*` 为 NULL 时,后续 `swift_checkMetadataState` → `isCanonicalStaticallySpecializedGenericMetadata()` 直接在 `this=0x0` 上按偏移读字段 → `KERN_INVALID_ADDRESS at 0x0`。寄存器 `x0=0`、`far=0` 与之吻合。

> 说明:第 4.2–4.4 是对"同名框架导致 Swift 类型系统串线"的**机制性**解释;能被证据**直接坐实**的是:①进程里同时存在两个名为 `Contacts` 的框架;②崩溃发生在实现 `ContactsUICore` 的类、实例化 `Combine.Published` 泛型元数据时;③拿到 NULL 指针;④把我们的模块改名(消除同名)后崩溃消失。因果链闭合。

---

## 5. 为什么"只在测试宿主启动时崩",而"编译期零警告"

- **测试宿主更容易触发**:`+[XCTestCase _allSubclasses]` 走 `objc_copyClassList` + `realizeAllClasses()`,**穷举实现进程内每一个类**(包括平时根本不会被碰到的 `ContactsUICore` 类)。纯 App 启动**不会**主动去 realize 所有类——只 realize 用到的;若 App 从不触及 Contacts UI,那条坏路径可能不被走到,于是"App 能起、测试必崩"。这解释了为什么现象集中在 `xcodebuild test`。
- **编译/链接为什么不报**:框架取什么名字是**链接期/运行期**的事,Swift 编译器不校验"你的模块名会不会和系统框架撞"。Tuist/xcodebuild 照样产出 `Contacts.framework`。冲突只在 **dyld 加载 + Swift 运行时解析元数据**时才现形——**没有任何静态检查兜底**(这正是"文件夹式看不见的耦合"的另一种形态:名字层面的隐性冲突)。

---

## 6. 为什么偏偏是 `Contacts`(其它 7 个模块没事)

本轮抽了 8 个功能模块:`Auth / Search / Discover / Me / Call / MiniApp / Chats / ContactBook`。会撞车的前提是**存在同名的 iOS 系统框架**:

| 模块名 | 系统里有无同名框架 | 结果 |
|---|---|---|
| **Contacts** | **有**:`Contacts.framework` / `ContactsUI` / `ContactsUICore` | **撞,崩** |
| Search | 无(系统无 `Search.framework`) | 安全 |
| Discover / Me / MiniApp / Chats / Auth | 无 | 安全 |
| Call | 无(通话是 `CallKit`,不是 `Call`) | 安全 |

> 高危名单(取名要避开):`Contacts` / `ContactsUI` / `Messages` / `Photos` / `PhotosUI` / `Intents` / `IntentsUI` / `Contacts` / `EventKit` / `HealthKit` / `Combine` / `Network` / `Vision` / `Accounts` / `Social` … 凡是 iOS 公有/私有框架名都不能作为自研 module 名。

---

## 7. 修复与验证

### 7.1 主修复:模块改名 `Contacts → ContactBook`

- `Project.swift`:`.target(name: "Contacts")` → `.target(name: "ContactBook")`,bundleId `…feature.contacts` → `…feature.contactbook`;`OurChat` / `OurChatTests` 的 `.target(name:)` 依赖同改。
- **源目录不动**(仍 `Sources/Features/Contacts/`)——Tuist 的 `sources` 是显式 glob,module 名与目录名解耦。
- 引用方 `import Contacts` → `import ContactBook`(App 组合根);测试 `@testable import Contacts` → `@testable import ContactBook`。
- **为什么不选"改类型名"**:业务类型仍叫 `ContactsFeature` 等,不受影响;只有**框架名**必须避系统名。改框架名改动面最小。

### 7.2 次生坑:改名后残留 DerivedData 触发 `objc_fatal`

改完名第一次跑,崩点**变了**:
```
libobjc  _objc_fatal → load_categories_nolock → loadAllCategoriesIfNeeded → load_images
dyld4::prepareSim
```
这是 **DerivedData 里残留的旧 `Contacts.framework` 与新 target 图串味**(load_images 阶段加载分类时对不上类)。清掉即好:
```
rm -rf ~/Library/Developer/Xcode/DerivedData/OurChat-*
tuist generate --no-open
xcodebuild test -workspace OurChat.xcworkspace -scheme OurChat \
  -destination 'platform=iOS Simulator,name=iPhone 17 Pro'
```
→ **183 tests / 40 suites 全绿**。改产物名/框架图之后**务必清 DerivedData**,否则旧框架残片会以各种诡异的启动崩溃形态出现。

### 7.3 验证当前状态

- `Project.swift` 中已无 `name: "Contacts"` 的 target,只有 `ContactBook`。
- 构建产物目录只有 `ContactBook.framework`,**无** `Contacts.framework` 残留。
- 你手上那份 crash 的 bundleId 是 `…feature.contacts`、时间戳早于改名 → 属**旧构建**,非当前代码。若在 Xcode 里仍复现,请 `tuist generate` 重新生成工程 + 清 DerivedData,让 Xcode 用上 `ContactBook`。

---

## 8. 方案对比(为何选"改名")

| 方案 | 能否解决 | 代价 / 风险 | 采纳 |
|---|---|---|---|
| **模块改名 `ContactBook`** | ✅ 根除(消除同名) | 改动面最小:改 target 名 + 少量 import;源目录/类型名不动 | **✔ 已采用** |
| 保留名 `Contacts`,只改 framework 产物名 | 理论可 | Tuist 里 target 名≈module 名≈产物名,强行拆开配置繁琐且脆弱,仍易撞 | �’✗ |
| 改为**静态**链接(`.staticFramework`/静态库) | ✅(运行时没有独立 `Contacts.framework`,自然无 install-name 冲突) | 需配套每模块测试宿主、二进制去重等更大改造(见模块化复盘 §5.1) | 未来收敛项,非本次 |
| 两级命名空间 / 手工调 rpath 顺序 | 不稳定 | 依赖加载顺序,脆弱、难维护、易回归 | ✗ |

**结论**:名字冲突就用"换个不冲突的名字"根治,别去和 dyld/rpath 搏斗。静态化虽然也能顺带消除该冲突,但那是更大范围的收敛,应独立推进。

---

## 9. 预防清单(取模块名时过一遍)

1. **自研 framework 名必须避开 iOS 系统框架名**(公有 + 私有)。拿不准就查:
   ```
   ls /Applications/Xcode.app/Contents/Developer/Platforms/iPhoneOS.platform/\
   Developer/SDKs/iPhoneOS.sdk/System/Library/Frameworks
   ```
   以及模拟器 runtime 下的 `PrivateFrameworks`。
2. 命名倾向:功能模块用**领域名 + 后缀**(`ContactBook` / `XxxFeature`)而非裸系统词。
3. **改产物名 / 动过 target 图后,先清 `DerivedData` 再 `tuist generate`**,避免残片崩溃。
4. **验证以命令行 `xcodebuild test` 为准**(与本项目既有约定一致);启动类崩溃优先看 crash report 的 **Binary Images 有无"同名两份"**、faulting thread 是否落在系统私有框架里。
5. 症状识别:`Early unexpected exit … bootstrapping … <external symbol>` + crash 落在 `realizeAllClasses` / `load_images` / 系统私有框架的元数据实例化 → **十有八九是框架名/符号冲突**,不是业务 bug。
