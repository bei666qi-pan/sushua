/**
 * 解析器单测:覆盖真实题库的各种脏格式。
 * 运行:npx tsx test/parser.test.ts,非零退出即失败。
 */
import { parseText } from "../src/lib/parser";

let failed = 0;
function assert(name: string, cond: boolean, detail = "") {
  if (cond) console.log(`  ✓ ${name}`);
  else {
    failed++;
    console.error(`  ✗ ${name}  ${detail}`);
  }
}

// ---------- 案例 1:用户真实题库格式(括号内嵌答案 + 无空格粘连选项,全角括号) ----------
console.log("1. 括号内嵌答案 + 无空格粘连选项(线上用户实测格式)");
{
  const { questions } = parseText(
    `1.党的十八大以来,中国特色社会主义进入新时代,以习近平同志为主要代表的中国共产党人,坚持把马克思主义基本原理同中国具体实际相结合,同(C)相结合, 创立了习近平新时代中国特色社会主义思想。
A.中华文化B.中华传统文化C.中华优秀传统文化D.优秀文化`
  );
  const q = questions[0];
  assert("切出 1 题", questions.length === 1);
  assert("题型单选", q?.type === "single", `got ${q?.type}`);
  assert("4 个选项", q?.options.length === 4, `got ${JSON.stringify(q?.options)}`);
  assert("选项内容正确", q?.options[0] === "中华文化" && q?.options[1] === "中华传统文化" && q?.options[2] === "中华优秀传统文化" && q?.options[3] === "优秀文化", JSON.stringify(q?.options));
  assert("答案 C", q?.answer === "C", `got ${q?.answer}`);
  assert("题干答案已挖空", !q?.stem.includes("(C)") && q?.stem.includes("("), q?.stem);
}

// ---------- 案例 2:半角括号内嵌答案(只认大写,防图标号误判) ----------
console.log("2. 半角括号内嵌大写答案");
{
  const { questions } = parseText(
    `2.在计算机中,存储容量的基本单位是(B)。
A.位B.字节C.字D.千字节`
  );
  const q = questions[0];
  assert("答案 B", q?.answer === "B", `got ${q?.answer}`);
  assert("选项 4 个", q?.options.length === 4, JSON.stringify(q?.options));
}

// ---------- 案例 3:粘连多选答案 (A、C) ----------
console.log("3. 括号内多选答案");
{
  const { questions } = parseText(
    `3.以下属于关系型数据库的是(A、C)。
A.MySQLB.RedisC.PostgreSQLD.MongoDB`
  );
  const q = questions[0];
  assert("题型多选", q?.type === "multiple", `got ${q?.type}`);
  assert("答案 AC", q?.answer === "AC", `got ${q?.answer}`);
  assert("选项拆对", q?.options[2] === "PostgreSQL", JSON.stringify(q?.options));
}

// ---------- 案例 4:判断题括号 (√) ----------
console.log("4. 判断题括号内 √/×");
{
  const { questions } = parseText(`4.TCP 协议是面向连接的可靠传输协议。(√)`);
  const q = questions[0];
  assert("题型判断", q?.type === "judge", `got ${q?.type}`);
  assert("答案 对", q?.answer === "对", `got ${q?.answer}`);
  const { questions: q2 } = parseText(`5.UDP 协议是面向连接的。(×)`);
  assert("答案 错", q2[0]?.answer === "错", `got ${q2[0]?.answer}`);
}

// ---------- 案例 5:粘连的 答案:/解析: ----------
console.log("5. 选项与答案解析粘连在一行");
{
  const { questions } = parseText(
    `6.HTTP 状态码 404 表示?A.服务器错误B.成功C.资源未找到D.重定向答案:C解析:404 即 Not Found。`
  );
  const q = questions[0];
  assert("4 个选项", q?.options.length === 4, JSON.stringify(q?.options));
  assert("选项 D 干净", q?.options[3] === "重定向", `got ${q?.options[3]}`);
  assert("答案 C", q?.answer === "C", `got ${q?.answer}`);
  assert("解析提取", (q?.explanation ?? "").includes("Not Found"), q?.explanation);
}

// ---------- 案例 6:不该拆的普通文本 ----------
console.log("6. 误拆保护");
{
  const { questions } = parseText(
    `7.关于 USB.接口下列说法正确的是(A)。
A.支持热插拔B.不支持热插拔C.必须重启D.以上都不对`
  );
  const q = questions[0];
  assert("USB. 未被误拆,题干完整", q?.stem.includes("USB.接口"), q?.stem);
  assert("答案 A", q?.answer === "A");
  const { questions: qs2 } = parseText(`8.IPv4 地址分为 A.B.C.D.四类,其中默认子网掩码为 255.255.255.0 的是哪一类?
答案:C`);
  assert("A.B.C.D. 连续空段不拆分", qs2[0]?.options.length === 0 && qs2[0]?.stem.includes("A.B.C.D.四类"), JSON.stringify(qs2[0]));
}

// ---------- 案例 7:标准分行格式回归 ----------
console.log("7. 标准分行格式回归");
{
  const { questions } = parseText(
    `一、单选题
1. 下列哪种数据结构遵循「先进先出」原则?
A. 栈
B. 队列
C. 二叉树
D. 哈希表
答案:B
解析:队列 FIFO。

二、判断题
2. 进程只能包含一个线程。
答案:错

三、填空题
3. OSI 参考模型共分为____层。
答案:7`
  );
  assert("切出 3 题", questions.length === 3, `got ${questions.length}`);
  assert("单选正常", questions[0]?.type === "single" && questions[0]?.answer === "B");
  assert("判断正常", questions[1]?.type === "judge" && questions[1]?.answer === "错");
  assert("填空正常", questions[2]?.type === "fill" && questions[2]?.answer === "7");
}

// ---------- 案例 8:顿号分隔选项粘连 ----------
console.log("8. 顿号分隔的粘连选项");
{
  const { questions } = parseText(
    `9.中国共产党的根本宗旨是(A)。
A、全心全意为人民服务B、实现共产主义C、解放生产力D、以经济建设为中心`
  );
  const q = questions[0];
  assert("4 个选项", q?.options.length === 4, JSON.stringify(q?.options));
  assert("答案 A", q?.answer === "A");
}

// ---------- 案例 9:【答案】格式 + 答案行含空格字母 ----------
console.log("9. 【答案】与空格分隔多选");
{
  const { questions } = parseText(
    `10.下列哪些排序算法平均时间复杂度为 O(n log n)?
A.冒泡排序
B.快速排序
C.归并排序
D.插入排序
【答案】 B C
【解析】分治类排序。`
  );
  const q = questions[0];
  assert("答案 BC(空格分隔归并)", q?.answer === "BC", `got ${q?.answer}`);
  assert("题型多选", q?.type === "multiple");
}

// ---------- 案例 10:答案行 + 题干括号明文答案挖空 ----------
console.log("10. 答案行与题干括号答案共存时挖空防剧透");
{
  const { questions } = parseText(
    `11.计算机网络中,OSI 模型的第三层是(C)。
A.物理层B.数据链路层C.网络层D.传输层
答案:C`
  );
  const q = questions[0];
  assert("答案 C", q?.answer === "C");
  assert("题干 (C) 已挖空", !q?.stem.includes("(C)"), q?.stem);
}

// ---------- 案例 11:空括号占位不误判 ----------
console.log("11. 空括号占位");
{
  const { questions } = parseText(
    `12.在关系数据库中,(  )是数据的基本存储单位。
A.表B.视图C.索引D.存储过程
答案:A`
  );
  const q = questions[0];
  assert("空括号保留,答案取自答案行", q?.answer === "A" && q?.stem.includes("("), q?.stem);
}

// ---------- 案例 12:答案字母超出选项范围 → 低置信度但保留 ----------
console.log("12. 答案超出选项范围");
{
  const { questions, leftovers } = parseText(
    `13.下列正确的是(F)。
A.选项一B.选项二C.选项三D.选项四`
  );
  assert("题目保留", questions.length === 1);
  assert("进入 AI 兜底队列", leftovers.length >= 1, `leftovers=${leftovers.length}`);
}

// ========== 以下为对抗性验证(28 agent)确认缺陷的回归用例 ==========

console.log("13. 题干含题型关键词不被当章节标题吞掉");
{
  const { questions } = parseText(`3.判断链表是否有环可以使用快慢指针法。(对)`);
  assert("『N.判断…』整题保留", questions.length === 1 && questions[0].type === "judge" && questions[0].answer === "对", JSON.stringify(questions[0]));
}
{
  const { questions } = parseText(`1.下列论述正确的是(  )
A.aa说法B.bb说法C.cc说法D.dd说法
答案:D`);
  assert("『下列论述正确的是』保留且答案 D", questions.length === 1 && questions[0].answer === "D", JSON.stringify(questions[0]));
}
{
  const { questions } = parseText(`1.名词解释:机会成本
答案:为了得到某种东西而放弃的其他东西的最大价值。`);
  assert("『N.名词解释:xx』保留且答案提取", questions.length === 1 && questions[0].stem.includes("名词解释") && questions[0].answer.includes("放弃"), JSON.stringify(questions[0]));
}
{
  const { questions } = parseText(`六、论述题
1.试论述毛泽东思想活的灵魂及其现实意义。
2.试论述中国式现代化的基本特征和本质要求。`);
  assert("『试论述』两题都保留", questions.length === 2 && questions.every((q) => q.type === "short"), `got ${questions.length}`);
}
{
  const { questions } = parseText(`1、(单选)下列属于流动资产的是(  )
A.机器设备B.存货C.厂房D.专利权
答案:B`);
  assert("『(单选)』标记题保留且答案 B", questions.length === 1 && questions[0].answer === "B" && questions[0].options.length === 4, JSON.stringify(questions[0]));
}
{
  const { questions } = parseText(`2、下列判断正确的是(  )
A.0是正数B.-1是自然数C.0是自然数D.分数都是有理数
答案:C`);
  assert("『下列判断正确的是』保留", questions.length === 1 && questions[0].answer === "C", JSON.stringify(questions[0]));
}
{
  const { questions } = parseText(`一、判断题(每题2分,共20分)
1.地球是太阳系的行星。
答案:对`);
  assert("真章节标题(带分数说明)仍生效", questions.length === 1 && questions[0].type === "judge" && questions[0].answer === "对", JSON.stringify(questions[0]));
}

console.log("14. 『多项选择题』章节识别为多选");
{
  const { questions } = parseText(`二、多项选择题
1.以下属于操作系统的是(  )
A.WindowsB.LinuxC.OfficeD.Android
答案:ABD`);
  assert("type=multiple 且答案 ABD", questions[0]?.type === "multiple" && questions[0]?.answer === "ABD", JSON.stringify(questions[0]));
}

console.log("15. 答案值与下一题号粘连");
{
  const { questions } = parseText(`1.C语言中sizeof(int)在32位系统下通常为(  )
A.1 B.2 C.4 D.8
答案:C2.C语言中用于动态分配内存的函数是(  )
A.alloc B.malloc C.new D.create
答案:B`);
  assert("切出 2 题", questions.length === 2, `got ${questions.length}`);
  assert("答案 C 和 B 都提取", questions[0]?.answer === "C" && questions[1]?.answer === "B", JSON.stringify(questions.map((q) => q.answer)));
  assert("选项各 4 个", questions[0]?.options.length === 4 && questions[1]?.options.length === 4);
}

console.log("16. 多题挤在一行(PDF 复制丢换行)");
{
  const { questions } = parseText(
    `1.OSI模型共有几层(  )A.5B.6C.7D.8答案:C2.TCP建立连接需要几次握手(  )A.1B.2C.3D.4答案:C`
  );
  assert("切出 2 题", questions.length === 2, `got ${questions.length} ${JSON.stringify(questions.map((q) => q.stem.slice(0, 12)))}`);
  assert("两题答案都是 C", questions[0]?.answer === "C" && questions[1]?.answer === "C", JSON.stringify(questions.map((q) => q.answer)));
  assert("选项 4+4", questions[0]?.options.length === 4 && questions[1]?.options.length === 4, JSON.stringify(questions.map((q) => q.options)));
}

console.log("17. (N) 括号编号题号");
{
  const { questions } = parseText(`一、单选题
1.HTTP默认端口是(  )
A.21 B.25 C.80 D.443
答案:C
二、填空题
(1)TCP协议工作在OSI模型的____层。
答案:传输
(2)IP地址127.0.0.1通常被称为____地址。
答案:回环`);
  assert("切出 3 题", questions.length === 3, `got ${questions.length}`);
  assert("单选答案 C 未被破坏", questions[0]?.answer === "C", `got ${questions[0]?.answer}`);
  assert("两道填空答案提取", questions[1]?.answer === "传输" && questions[2]?.answer === "回环", JSON.stringify(questions.slice(1).map((q) => q.answer)));
}

console.log("18. 简答题答案编号要点不切成假题");
{
  const { questions } = parseText(`五、简答题
1.简述死锁产生的四个必要条件。
答案:
1.互斥条件
2.请求与保持条件
3.不可剥夺条件
4.循环等待条件`);
  assert("只有 1 道题(不产生假题)", questions.length === 1, `got ${questions.length}`);
  assert("答案包含全部要点", (questions[0]?.answer ?? "").includes("互斥") && (questions[0]?.answer ?? "").includes("循环等待"), questions[0]?.answer);
}

console.log("19. 答案带句号/全角句号");
{
  const { questions } = parseText(`1.下列属于生产要素的是(  )
A.土地B.劳动C.资本D.水果
答案:ABC。`);
  assert("『答案:ABC。』提取为 ABC", questions[0]?.answer === "ABC", `got ${questions[0]?.answer}`);
}
{
  const { questions } = parseText(`1.光速在真空中约为每秒30万公里。
答案:正确。`);
  assert("『答案:正确。』判断题提取", questions[0]?.type === "judge" && questions[0]?.answer === "对", JSON.stringify(questions[0]));
}

console.log("20. 『答案是X』『答:』标签");
{
  const { questions } = parseText(`1.CPU 对应的英文缩写含义是(  )
A.中央处理器B.图形处理器C.内存D.硬盘
答案是A`);
  assert("『答案是A』提取", questions[0]?.answer === "A", `got ${questions[0]?.answer}`);
}
{
  const { questions } = parseText(`1.简述TCP三次握手的过程。
答:第一次客户端发送SYN,第二次服务端回复SYN+ACK,第三次客户端发送ACK,连接建立。`);
  assert("『答:』提取且题干干净", (questions[0]?.answer ?? "").includes("SYN") && !questions[0]?.stem.includes("答:"), JSON.stringify(questions[0]));
}

console.log("21. 行内『( 答案:X )』");
{
  const { questions } = parseText(`1.我国的根本政治制度是( 答案:A )
A.人民代表大会制度B.多党合作和政治协商制度C.民族区域自治制度D.基层群众自治制度`);
  assert("答案 A 且题干挖空", questions[0]?.answer === "A" && !questions[0]?.stem.includes("答案"), JSON.stringify(questions[0]));
}
{
  const { questions } = parseText(`1.中国特色社会主义最本质的特征是中国共产党领导。( 答案:√ )`);
  assert("判断题( 答案:√ )", questions[0]?.type === "judge" && questions[0]?.answer === "对", JSON.stringify(questions[0]));
}

console.log("22. 小写图标号(a)不误判为答案");
{
  const { questions } = parseText(`1.如图(a)所示电路,开关闭合后电流方向为(  )
A.顺时针B.逆时针C.不确定D.无电流
答案:A`);
  assert("(a) 保留在题干,答案取自答案行", questions[0]?.stem.includes("(a)") && questions[0]?.answer === "A", JSON.stringify(questions[0]));
}
{
  const { questions } = parseText(`1.如图(a)所示,单摆的周期与摆长的关系是(  )
A.正比B.反比C.与摆长平方根成正比D.无关`);
  assert("无答案行时 (a) 也不被提取", questions[0]?.answer === "", `got ${questions[0]?.answer}`);
}

console.log("23. 判断题 答案:F / 答案:T");
{
  const { questions } = parseText(`1.太阳绕地球公转。
答案:F
2.地球绕太阳公转。
答案:T`);
  assert("F → 错,T → 对", questions[0]?.answer === "错" && questions[1]?.answer === "对", JSON.stringify(questions.map((q) => q.answer)));
  assert("题型均为判断", questions.every((q) => q.type === "judge"));
}

console.log("24. 解析粘连下一题:不静默丢失");
{
  const { questions, leftovers } = parseText(
    `1.SQL中删除表结构的命令是(  )A.DELETEB.DROPC.REMOVED.CLEAR答案:B解析:DELETE删数据,DROP删结构2.SQL中的聚合函数不包括(  )A.SUMB.AVGC.WHERED.COUNT答案:C`
  );
  const q1 = questions.find((q) => q.stem.includes("删除表结构"));
  assert("题1保留且答案 B", !!q1 && q1.answer === "B", JSON.stringify(q1));
  const rescued = questions.some((q) => q.stem.includes("聚合函数")) || leftovers.some((s) => s.includes("聚合函数"));
  assert("题2 不静默丢失(进题目或 AI 兜底)", rescued, `leftovers=${leftovers.length}`);
}

console.log("25. 文末答案表不产生垃圾题");
{
  const { questions } = parseText(`1.HTTP默认端口是(  )
A.21 B.25 C.80 D.443
2.FTP默认端口是(  )
A.20 B.21 C.22 D.23
参考答案
1.C
2.B`);
  const garbage = questions.filter((q) => q.stem.replace(/[\s..、()()]/g, "").length <= 2);
  assert("无 1-2 字的垃圾题", garbage.length === 0, JSON.stringify(garbage));
  assert("两道真题保留", questions.filter((q) => q.options.length === 4).length === 2);
}

if (failed) {
  console.error(`\n${failed} 项断言失败`);
  process.exit(1);
}
console.log("\n全部通过 ✓");
