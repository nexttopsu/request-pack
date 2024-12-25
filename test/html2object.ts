import { html2object } from '../src'

const html = `<html>
<head><title>标题</title></head>
<body>

<h1 class="todo"><span>Todo</span></h1>
<ul id="list">
    <li data-href="/1"><span>1</span></li>
    <li data-href="/2"><span>2</span></li>
    <li data-href="/3"><span>3</span></li>
</ul>
</body>
<html>`

console.log(html2object(html, {
    title: 'title/text()',
    h1: '.todo/text()',
    h1_html: '.todo/html()',
    list: '#list li/loop(/attr(data-href), span/text())'
}));

// ==> result
// {
//     title: '标题',
//     h1: 'Todo',
//     h1_html: '<span>Todo</span>',
//     list: [ [ '/1', '1' ], [ '/2', '2' ], [ '/3', '3' ] ]
// }