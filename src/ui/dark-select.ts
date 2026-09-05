// Keep native select values/change events as the source of truth, but draw
// the popup ourselves: GTK/WebKit native menus can ignore option colors.
let closeMenu: (()=>void) | undefined;
let serial=0;
const controls=new WeakMap<HTMLSelectElement,{button:HTMLButtonElement;refresh:()=>void}>();
export function enhanceSelects(root: ParentNode): void {
  root.querySelectorAll('select').forEach(select=>{
    const existing=controls.get(select);
    if(existing){existing.refresh();return;}
    const label=select.getAttribute('aria-label') ||
      Array.from(select.closest('label')?.childNodes??[]).filter(n=>n.nodeType===Node.TEXT_NODE).map(n=>n.textContent).join('').trim() ||
      (select.id==='beats-per-bar'?'Time signature':select.name||'Choose an option');
    const button=document.createElement('button');
    button.type='button';button.className='dark-select';button.setAttribute('role','combobox');
    button.setAttribute('aria-label',label);button.setAttribute('aria-haspopup','listbox');button.setAttribute('aria-expanded','false');
    const refresh=()=>{button.textContent=select.selectedOptions[0]?.textContent??'';button.disabled=select.disabled;};
    select.hidden=true;select.insertAdjacentElement('afterend',button);
    controls.set(select,{button,refresh});select.addEventListener('change',refresh);refresh();
    const open=()=>{
      closeMenu?.();refresh();
      const menu=document.createElement('div');menu.className='dark-select-menu';menu.id=`select-menu-${++serial}`;
      menu.setAttribute('role','listbox');menu.setAttribute('aria-label',label);menu.tabIndex=-1;
      button.setAttribute('aria-controls',menu.id);button.setAttribute('aria-expanded','true');
      const options=Array.from(select.options);let active=Math.max(0,select.selectedIndex);
      const close=()=>{menu.remove();button.setAttribute('aria-expanded','false');button.removeAttribute('aria-controls');button.removeAttribute('aria-activedescendant');document.removeEventListener('pointerdown',outside,true);window.removeEventListener('resize',close);document.removeEventListener('scroll',scroll,true);closeMenu=undefined;};
      const outside=(event:PointerEvent)=>{if(!menu.contains(event.target as Node)&&!button.contains(event.target as Node))close();};
      const scroll=(event:Event)=>{if(!menu.contains(event.target as Node))close();};
      const highlight=()=>{
        Array.from(menu.children).forEach((child,i)=>{child.classList.toggle('highlighted',i===active);});
        button.setAttribute('aria-activedescendant',`${menu.id}-${active}`);
        menu.setAttribute('aria-activedescendant',`${menu.id}-${active}`);
        menu.children[active]?.scrollIntoView({block:'nearest'});
      };
      const choose=(i:number)=>{
        if(options[i]?.disabled)return;
        select.selectedIndex=i;close();refresh();select.dispatchEvent(new Event('change',{bubbles:true}));
        // Editing a fret may replace the entire control synchronously.
        if(button.isConnected)button.focus();
      };
      options.forEach((option,i)=>{
        const item=document.createElement('div');item.id=`${menu.id}-${i}`;item.setAttribute('role','option');item.setAttribute('aria-selected',String(option.selected));
        item.setAttribute('aria-disabled',String(option.disabled));item.textContent=option.textContent;
        item.addEventListener('click',()=>choose(i));menu.appendChild(item);
      });
      const rect=button.getBoundingClientRect();document.body.appendChild(menu);
      const width=Math.max(rect.width,100);const height=Math.min(menu.scrollHeight,240,window.innerHeight-16);
      menu.style.width=`${width}px`;menu.style.maxHeight=`${height}px`;
      menu.style.left=`${Math.min(rect.left,window.innerWidth-width-8)}px`;
      menu.style.top=`${rect.bottom+height+4<=window.innerHeight?rect.bottom+4:Math.max(8,rect.top-height-4)}px`;
      menu.addEventListener('keydown',event=>{
        if(event.key==='Escape'||event.key==='Tab'){close();button.focus();return;}
        if(event.key==='Enter'||event.key===' '){event.preventDefault();choose(active);return;}
        if(['ArrowDown','ArrowUp','Home','End'].includes(event.key)){
          event.preventDefault();active=event.key==='Home'?0:event.key==='End'?options.length-1:Math.max(0,Math.min(options.length-1,active+(event.key==='ArrowDown'?1:-1)));highlight();
        }else if(event.key.length===1){const match=options.findIndex(o=>o.text.toLowerCase().startsWith(event.key.toLowerCase()));if(match>=0){active=match;highlight();}}
      });
      document.addEventListener('pointerdown',outside,true);window.addEventListener('resize',close);document.addEventListener('scroll',scroll,true);
      closeMenu=close;menu.focus();highlight();
    };
    button.addEventListener('click',event=>{event.preventDefault();if(button.getAttribute('aria-expanded')==='true')closeMenu?.();else open();});
    button.addEventListener('keydown',event=>{if(event.key==='ArrowDown'||event.key==='ArrowUp'){event.preventDefault();open();}});
  });
}
export function focusSelect(select:HTMLSelectElement|undefined|null):void {if(select)controls.get(select)?.button.focus();}
export function isSelectEditing():boolean {return Boolean(closeMenu)||document.activeElement?.classList.contains('dark-select')===true;}
