import { createHttp } from './src/index'


const http = createHttp({
    proxy: {
        host: '127.0.0.1',
        port: 1080
    }
})


http.get('https://www.youtube.com').then(res => {
    console.log(res)
})
