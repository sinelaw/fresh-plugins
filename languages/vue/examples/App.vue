<script setup lang="ts">
import { ref, computed, onMounted } from 'vue'

interface Todo {
  id: number
  text: string
  done: boolean
}

const props = defineProps<{
  title?: string
}>()

const todos = ref<Todo[]>([
  { id: 1, text: 'Learn Vue 3', done: true },
  { id: 2, text: 'Build something', done: false },
])

const newTodo = ref('')

const remaining = computed(() =>
  todos.value.filter((t) => !t.done).length
)

function addTodo() {
  if (!newTodo.value.trim()) return
  todos.value.push({
    id: Date.now(),
    text: newTodo.value.trim(),
    done: false,
  })
  newTodo.value = ''
}

function removeTodo(id: number) {
  todos.value = todos.value.filter((t) => t.id !== id)
}

onMounted(() => {
  console.log('App mounted')
})
</script>

<template>
  <div class="app">
    <h1>{{ props.title ?? 'Todos' }}</h1>
    <p>{{ remaining }} remaining</p>

    <form @submit.prevent="addTodo">
      <input
        v-model="newTodo"
        placeholder="Add a todo..."
        :disabled="todos.length >= 100"
      />
      <button type="submit">Add</button>
    </form>

    <ul>
      <li
        v-for="todo in todos"
        :key="todo.id"
        :class="{ done: todo.done }"
      >
        <input
          type="checkbox"
          v-model="todo.done"
        />
        <span>{{ todo.text }}</span>
        <button @click="removeTodo(todo.id)">&times;</button>
      </li>
    </ul>

    <template v-if="todos.length === 0">
      <p>All done!</p>
    </template>
  </div>
</template>

<style scoped>
.app {
  max-width: 480px;
  margin: 0 auto;
  padding: 2rem;
  font-family: sans-serif;
}

h1 {
  color: #42b883;
}

.done span {
  text-decoration: line-through;
  opacity: 0.6;
}

button {
  cursor: pointer;
  padding: 0.25rem 0.5rem;
  border: 1px solid #ccc;
  border-radius: 4px;
  background: v-bind('props.title ? "#42b883" : "#fff"');
}
</style>
