import { request_inst, request, request_buffer } from '../src'

request_inst.defaults.proxy = {
    host: "127.0.0.1",
    port: 1080
}
request_inst.defaults.headers['User-Agent'] = 'Mozilla/5.0 (Windows NT 6.1; Win64; WOW64) AppleWebKit/537.36 (KHTML, like Gecko/2010010 Safari/537.36';

// 不使用代理
request('https://www.baidu.com').then(res => {
    console.log(res);
});

// 使用代理
request('https://www.youtube.com', undefined, true).then(res => {
    console.log(res);
});

request_buffer('https://www.baidu.com/img/flexible/logo/pc/result.png').then(res => {
    const buff = res.data;
    // fs.writeFileSync(path.resolve('test.png'), res.data);
});
