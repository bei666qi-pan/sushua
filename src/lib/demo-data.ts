import type { DraftQuestion } from "./types";

/** 内置 10 题示例(与 public/demo.txt 内容一致),用于种子题库与新手体验 */
export const DEMO_QUESTIONS: DraftQuestion[] = [
  {
    type: "single",
    stem: "在计算机中,1 KB 等于多少字节?",
    options: ["1000 字节", "1024 字节", "1024 位", "8 字节"],
    answer: "B",
    explanation: "K 在计算机存储中按 2 的 10 次方计,1KB = 1024B。",
  },
  {
    type: "single",
    stem: "下列哪种数据结构遵循「先进先出」原则?",
    options: ["栈", "队列", "二叉树", "哈希表"],
    answer: "B",
    explanation: "队列 FIFO,栈是 LIFO。",
  },
  {
    type: "single",
    stem: "HTTP 状态码 404 表示什么?",
    options: ["服务器内部错误", "请求成功", "资源未找到", "重定向"],
    answer: "C",
  },
  {
    type: "multiple",
    stem: "以下哪些属于关系型数据库?",
    options: ["MySQL", "Redis", "PostgreSQL", "MongoDB"],
    answer: "AC",
    explanation: "Redis 是键值库,MongoDB 是文档库。",
  },
  {
    type: "multiple",
    stem: "下列哪些排序算法的平均时间复杂度为 O(n log n)?",
    options: ["冒泡排序", "快速排序", "归并排序", "插入排序"],
    answer: "BC",
  },
  {
    type: "judge",
    stem: "TCP 协议是面向连接的可靠传输协议。",
    options: [],
    answer: "对",
    explanation: "TCP 三次握手建立连接,有确认重传机制;UDP 才是无连接不可靠的。",
  },
  {
    type: "judge",
    stem: "进程是操作系统资源分配的最小单位,线程是 CPU 调度的最小单位,因此一个进程只能包含一个线程。",
    options: [],
    answer: "错",
    explanation: "前半句正确,但一个进程可以包含多个线程。",
  },
  {
    type: "fill",
    stem: "OSI 参考模型共分为____层。",
    options: [],
    answer: "7",
  },
  {
    type: "fill",
    stem: "二进制数 1010 对应的十进制数是____。",
    options: [],
    answer: "10",
  },
  {
    type: "short",
    stem: "简述死锁产生的四个必要条件。",
    options: [],
    answer: "互斥条件;请求与保持条件;不可剥夺条件;循环等待条件。四者同时满足才会死锁,破坏任一即可预防。",
  },
];
