// 故意不调用 defineThreadTask：worker 执行完即以 code 0 退出，用于验证
// TaskPool 不会因为拿不到回包而永久挂起。
export {};
