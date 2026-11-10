// dsh-plugin-team-group — browser half.
//
// 把 /team-group 群聊面板挂进侧边栏 + 主视图（照 dsh-plugin-starmap 的挂法）。
// 真正的群聊渲染在独立页面里跑，不跟宿主会话视图抢渲染。
window.__ModuleLoader__.load({
  id: 'dsh-plugin-team-group',
  factory: function (require) {
    var module = { exports: {} }
    var React = require('react')

    function Panel() {
      return React.createElement('iframe', {
        title: '团队群聊',
        src: '/team-group',
        style: {
          width: '100%', height: '100%', border: 0, display: 'block',
          background: '#0a0d18', colorScheme: 'dark',
        },
      })
    }

    // 侧边栏图标：两个人围成一圈
    function Icon(size) {
      var s = typeof size === 'number' ? size : 16
      return React.createElement(
        'svg',
        { width: s, height: s, viewBox: '0 0 16 16', fill: 'none', xmlns: 'http://www.w3.org/2000/svg' },
        React.createElement('circle', { cx: 5.4, cy: 6.2, r: 2.1, fill: 'currentColor' }),
        React.createElement('circle', { cx: 10.8, cy: 6.2, r: 2.1, fill: 'currentColor', opacity: .72 }),
        React.createElement('path', { d: 'M1.6 13.4c0-2.1 1.7-3.5 3.8-3.5s3.8 1.4 3.8 3.5z', fill: 'currentColor' }),
        React.createElement('path', { d: 'M7.6 13.4c.2-2 1.6-3.3 3.2-3.3 2 0 3.6 1.4 3.6 3.3z', fill: 'currentColor', opacity: .72 }),
      )
    }

    module.exports = {
      inject: ['slots'],
      apply: function (ctx) {
        ctx.slots.inject('main', function () {
          return ctx.slots.register({ name: 'main', key: 'team-group' }, Panel)
        })
        ctx.slots.inject('sidebar.panellist', function () {
          return ctx.slots.register(
            { name: 'sidebar.panellist', id: 'team-group', order: 22, label: '团队' },
            Icon,
          )
        })
      },
    }
    return module.exports
  },
})
